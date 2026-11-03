import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db/database.js";
import { scanRepo } from "../pipeline/scan.js";
import type { SymbolChangeDto } from "../types.js";
import { buildBaseline, listCommits } from "./baseline.js";
import { clusterChanges } from "./compare.js";
import { buildChangeReport } from "./report.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-diff-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
}

function repoAtBase(): string {
  const root = mkdtempSync(join(tmpdir(), "repolens-diff-"));
  roots.push(root);
  write(root, {
    ".repolens.json": JSON.stringify({ llm: { enabled: false } }),
    "package.json": JSON.stringify({ name: "diff-fixture", type: "module" }),
    "src/api.ts": `
      import { load } from "./store";
      const app = { get(p: string, h: unknown): void {}, post(p: string, h: unknown): void {} };
      export function getItem(id: string) { return load(id); }
      app.get("/items/:id", getItem);
    `,
    "src/store.ts": `
      import { readFileSync } from "node:fs";
      export function load(id: string) { return readFileSync(id, "utf8"); }
      export function unused() { return 1; }
    `,
    "src/util/format.ts": "export function fmt(x: string) { return x.trim(); }\n",
    "src/helpers.ts": "export function clamp(n: number) { return Math.max(0, n); }\n",
  });
  git(root, "init", "-q");
  // Windows CI has autocrlf enabled by default: git archive exports CRLF, but here it is written directly as LF, so every file will be considered modified.
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

describe("变更视角", () => {
  it("对比工作区与基线提交：文件、符号、依赖、外部库、入口与影响面", async () => {
    const root = repoAtBase();
    write(root, {
      "src/api.ts": `
        import { z } from "zod";
        import { load, save } from "./store";
        import { fmt } from "./util/format";
        const app = { get(p: string, h: unknown): void {}, post(p: string, h: unknown): void {} };
        export function getItem(id: string) { return load(fmt(id)); }
        export function createItem(body: string) { return save(z.string().parse(body)); }
        app.get("/items/:id", getItem);
        app.post("/items", createItem);
      `,
      "src/store.ts": `
        import { readFileSync, writeFileSync } from "node:fs";
        export function load(id: string) { return readFileSync(id, "utf8").toUpperCase(); }
        export function save(body: string) { writeFileSync("out.txt", body); }
      `,
      "src/lib/helpers.ts": "export function clamp(n: number) { return Math.max(0, n); }\n",
    });
    unlinkSync(join(root, "src/helpers.ts"));
    await scanRepo({ root });

    const report = await buildChangeReport(root, { base: "HEAD" });
    expect(report.base.ref).toBe("HEAD");
    expect(report.head).toBeNull();

    expect(report.files.map((f) => [f.status, f.path, f.from ?? null])).toEqual([
      ["modified", "src/api.ts", null],
      ["modified", "src/store.ts", null],
      ["moved", "src/lib/helpers.ts", "src/helpers.ts"],
    ]);

    const symbols = report.symbols.map((s) => [s.status, `${s.path}:${s.name}`]);
    expect(symbols).toEqual(expect.arrayContaining([
      ["modified", "src/api.ts:getItem"],
      ["added", "src/api.ts:createItem"],
      ["modified", "src/store.ts:load"],
      ["added", "src/store.ts:save"],
      ["removed", "src/store.ts:unused"],
    ]));
    expect(report.symbols.find((s) => s.name === "load")).toMatchObject({ shapeChanged: true, callers: 1, exported: true });
    expect(report.symbols.find((s) => s.name === "unused")).toMatchObject({ id: null, callers: 0 });

    expect(report.dependencies).toEqual([
      { status: "added", level: "directory", source: "src", target: "src/util", type: "imports", count: 1 },
    ]);
    expect(report.externals).toEqual({ added: ["zod"], removed: [] });

    expect(report.entries.map((e) => [e.status, e.label])).toEqual(expect.arrayContaining([
      ["added", "POST /items"],
      ["affected", "GET /items/:id"],
    ]));
    const affected = report.entries.find((e) => e.label === "GET /items/:id");
    expect(affected?.via.map((v) => [v.name, v.depth])).toEqual([["getItem", 0], ["load", 1]]);

    // Behavior: Who was newly called, what type of I/O is being accessed; built-in language functions (toUpperCase) do not count
    const behavior = Object.fromEntries(report.behavior.map((b) => [b.name, b]));
    expect(behavior["getItem"]).toMatchObject({
      status: "modified", callsAdded: [{ name: "fmt", external: null }], callsRemoved: [], ioAdded: [],
    });
    expect(behavior["load"]).toBeUndefined();
    expect(behavior["save"]).toMatchObject({ status: "added", ioAdded: ["filesystem"] });
    expect(behavior["createItem"]?.callsAdded.map((c) => c.external ? `${c.external}:${c.name}` : c.name)).toEqual(["save"]);
    expect(report.entries.find((e) => e.label === "POST /items")?.ioAdded).toEqual(["filesystem"]);
    expect(report.symbols.find((s) => s.name === "save")?.tests).toBe(0);

    // Modified units: grouped along call relationships, with the new I/O group placed first
    expect(report.clusters.map((c) => [c.label, c.members.length])).toEqual([["createItem", 2], ["getItem", 2]]);
    expect(report.clusters[0]?.reasons).toEqual(expect.arrayContaining([{ kind: "io", count: 1 }, { kind: "untested", count: 2 }]));
  });

  it("基线按提交缓存；子目录扫描根在旧提交里不存在时基线为空", async () => {
    const root = repoAtBase();
    const first = await buildBaseline(root, "HEAD");
    const again = await buildBaseline(root, "HEAD");
    expect(first.reused).toBe(false);
    expect(again).toMatchObject({ reused: true, commit: first.commit, dbPath: first.dbPath });
    expect(existsSync(first.dbPath)).toBe(true);

    write(root, { "apps/new/src/main.ts": "export function main() { return 1; }\n" });
    const sub = join(root, "apps/new");
    await scanRepo({ root: sub });
    const report = await buildChangeReport(sub, { base: "HEAD" });
    expect(report.files.map((f) => [f.status, f.path])).toEqual([["added", "src/main.ts"]]);
  });

  it("不是 git 仓库或找不到提交时给出可读的错误", async () => {
    const plain = mkdtempSync(join(tmpdir(), "repolens-diff-plain-"));
    roots.push(plain);
    await expect(buildBaseline(plain, "HEAD")).rejects.toThrow("不是 git 仓库");
    const root = repoAtBase();
    await expect(buildBaseline(root, "no-such-branch")).rejects.toThrow("找不到提交 no-such-branch");
  });

  it("可选的基线提交：新的在前，带分支和 tag，只列动过扫描根的", () => {
    const root = repoAtBase();
    git(root, "tag", "v1");
    write(root, { "apps/web/main.ts": "export const a = 1;\n" });
    git(root, "add", ".");
    git(root, "commit", "-m", "add web app");
    write(root, { "README.md": "readme\n" });
    git(root, "add", ".");
    git(root, "commit", "-m", "docs only");

    const all = listCommits(root);
    expect(all.map((c) => c.subject)).toEqual(["docs only", "add web app", "base"]);
    expect(all[0]).toMatchObject({ head: true, author: "t", tags: [] });
    expect(all[0]?.branches.length).toBe(1);
    expect(all[2]).toMatchObject({ head: false, branches: [], tags: ["v1"] });
    expect(all[2]?.commit).toMatch(/^[0-9a-f]{40}$/);

    expect(listCommits(join(root, "apps/web")).map((c) => c.subject)).toEqual(["add web app"]);
    const plain = mkdtempSync(join(tmpdir(), "repolens-diff-plain-"));
    roots.push(plain);
    expect(listCommits(plain)).toEqual([]);
  });

  it("改动单元：大家都在用的工具函数自成一组，不把不相干的改动连成一团；类型按文件归组", () => {
    const dir = mkdtempSync(join(tmpdir(), "repolens-diff-cluster-"));
    roots.push(dir);
    const db = openDb(join(dir, "index.db"), { fresh: true });
    try {
      const names = ["a", "a2", "b", "c", "d", "t"];
      const call = db.prepare(
        "INSERT INTO edges (type, src_kind, src_id, dst_kind, dst_id, confidence, weight) VALUES ('calls', 'symbol', ?, 'symbol', ?, 'exact', 1)",
      );
      const id = (name: string) => names.indexOf(name) + 1;
      call.run(id("a"), id("a2"));
      for (const caller of ["a", "b", "c", "d"]) call.run(id(caller), id("t"));

      const change = (name: string, kind: SymbolChangeDto["kind"] = "function", path = "src/app.ts"): SymbolChangeDto => ({
        status: "modified", id: `sym:${kind === "function" ? id(name) : 100 + name.length}`, name, container: null, kind, path, line: 1,
        exported: false, role: "source", complexity: 1, complexityBefore: 1, signature: null, signatureBefore: null,
        shapeChanged: true, callers: 0, tests: 1,
      });
      const symbols = [...names.map((name) => change(name)), change("Item", "interface", "src/types.ts"), change("Order", "type", "src/types.ts")];
      const clusters = clusterChanges(db, symbols, [], []);
      expect(clusters.map((c) => [c.label, c.members.length]).sort()).toEqual([
        ["a", 2], ["b", 1], ["c", 1], ["d", 1], ["t", 1], ["types.ts", 2],
      ]);
    } finally {
      db.close();
    }
  });
});
