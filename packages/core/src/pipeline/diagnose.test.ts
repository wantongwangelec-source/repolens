import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { getFindings, getFindingSummary } from "../db/queries.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-diagnose-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scanFixture(files: Record<string, string>): Promise<Db> {
  const root = mkdtempSync(join(tmpdir(), "repolens-diagnose-"));
  roots.push(root);
  writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await scanRepo({ root, fresh: true });
  return openDb(indexPath(root), { readonly: true });
}

const repeat = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("\n");

/** 26 if statements: Complexity 27 */
const BRANCHY = `export function route(x: number): number {\n${repeat(26, (i) => `  if (x === ${i}) return ${i};`)}\n  return -1;\n}\n`;
/** 220 lines, 12 branches */
const LONG = `export function pipeline(input: number[]): number {\n  let total = 0;\n${repeat(12, (i) => `  if (input[${i}]) total += ${i};`)}\n${repeat(206, (i) => `  total += ${i};`)}\n  return total;\n}\n`;
/** 220 lines but can be read at a glance */
const FLAT = `export function mapping(): Record<string, number> {\n  const out: Record<string, number> = {};\n${repeat(216, (i) => `  out.k${i} = ${i};`)}\n  return out;\n}\n`;
/** Ten inline routes, each with three branches: the outer layer only registers itself */
const ROUTES = `declare const app: { get(path: string, fn: (c: number) => number): void };\nexport function createApi(): void {\n${repeat(10, (i) => `  app.get("/r${i}", (c) => {\n    if (c === 1) return 1;\n    if (c === 2) return 2;\n    if (c === 3) return 3;\n    return 0;\n  });`)}\n}\n`;

describe("过大的函数和文件", () => {
  it("分支过多、又长又绕的函数进体检；只长不绕的、测试里的不报", async () => {
    const db = await scanFixture({
      "src/branchy.ts": BRANCHY,
      "src/long.ts": LONG,
      "src/flat.ts": FLAT,
      "src/api.ts": ROUTES,
      "src/branchy.test.ts": BRANCHY.replace("route", "routeCase"),
    });
    try {
      const titles = getFindings(db, { kind: "oversized" }).map((f) => [f.path, f.title, f.severity]).sort();
      expect(titles).toEqual([
        ["src/branchy.ts", "route() 分支过多：复杂度 27，29 行", "low"],
        ["src/long.ts", "pipeline() 过长：222 行，复杂度 13", "low"],
      ]);
    } finally {
      db.close();
    }
  });

  it("体检结论可以限定在目录、文件、符号里，计数跟着收窄", async () => {
    const db = await scanFixture({
      "src/a/branchy.ts": BRANCHY,
      "src/b/long.ts": LONG,
    });
    try {
      const paths = (scope: string) => getFindings(db, { kind: "oversized", scope }).map((f) => f.path);
      expect(paths("dir:src")).toHaveLength(2);
      expect(paths("dir:src/a")).toEqual(["src/a/branchy.ts"]);
      const file = db.prepare("SELECT id FROM files WHERE path = 'src/b/long.ts'").get() as { id: number };
      expect(paths(`file:${file.id}`)).toEqual(["src/b/long.ts"]);
      const route = db.prepare("SELECT id FROM symbols WHERE name = 'route'").get() as { id: number };
      expect(paths(`sym:${route.id}`)).toEqual(["src/a/branchy.ts"]);
      expect(getFindingSummary(db, "dir:src/a").byKind["oversized"]).toBe(1);
      expect(getFindingSummary(db).byKind["oversized"]).toBe(2);
    } finally {
      db.close();
    }
  });

  it("嵌套的内联 handler 自成符号，复杂度不再算进外层，文件合计也不重复", async () => {
    const db = await scanFixture({ "src/api.ts": ROUTES });
    try {
      const symbols = db.prepare(
        "SELECT name, complexity FROM symbols WHERE kind = 'function' ORDER BY start_line, name",
      ).all() as Array<{ name: string; complexity: number }>;
      expect(symbols[0]).toEqual({ name: "createApi", complexity: 1 });
      expect(symbols.slice(1).map((s) => s.complexity)).toEqual(Array(10).fill(4));
      const file = db.prepare("SELECT complexity FROM files WHERE path = 'src/api.ts'").get() as { complexity: number };
      // declare const app is also a symbol
      expect(file.complexity).toBe(1 + 1 + 10 * 4);
    } finally {
      db.close();
    }
  });

  it("又长、总复杂度又高的文件报一条，并列出最长的函数作为拆分切口", async () => {
    const body = repeat(120, (i) => `export function step${i}(x: number): number {\n  if (x > ${i}) {\n    return x - ${i};\n  }\n  const y = x * 2;\n  const z = y + ${i};\n  const w = z - 1;\n  return w;\n}\n`);
    const db = await scanFixture({ "src/huge.ts": body, "src/types.ts": repeat(1100, (i) => `export type T${i} = { v: ${i} };`) });
    try {
      const findings = getFindings(db, { kind: "oversized" });
      expect(findings.map((f) => [f.path, f.scopeKind])).toEqual([["src/huge.ts", "file"]]);
      expect(findings[0]!.title).toMatch(/^文件过大：\d{4} 行代码，120 个函数，总复杂度 240$/);
      expect(findings[0]!.detail.split("\n")).toHaveLength(6);
    } finally {
      db.close();
    }
  });
});

describe("模块环", () => {
  it("测试文件反向 import 被测模块不构成环，也不进目录/包级依赖边", async () => {
    const db = await scanFixture({
      "src/llm/enrich.ts": 'import { scan } from "../pipeline/scan";\nexport function enrich() { return scan(); }\n',
      "src/pipeline/scan.ts": "export function scan() { return 1; }\n",
      "src/pipeline/scan.test.ts": 'import { enrich } from "../llm/enrich";\nenrich();\n',
      "src/a/one.ts": 'import { two } from "../b/two";\nexport function one() { return two(); }\n',
      "src/b/two.ts": 'import { one } from "../a/one";\nexport function two(): number { return one(); }\n',
    });
    try {
      const cycles = db.prepare(
        "SELECT GROUP_CONCAT(path) AS members FROM findings WHERE kind = 'cycle' GROUP BY group_key",
      ).all();
      expect(cycles).toEqual([{ members: "src/a,src/b" }]);
      const rollups = db.prepare("SELECT src, dst FROM rollup_edges WHERE level = 'directory' ORDER BY 1, 2").all();
      expect(rollups).toEqual([
        { src: "src/a", dst: "src/b" },
        { src: "src/b", dst: "src/a" },
        { src: "src/llm", dst: "src/pipeline" },
      ]);
      const testEdge = db.prepare(
        `SELECT COUNT(*) AS n FROM edges e JOIN files f ON f.id = e.src_id
         WHERE e.src_kind = 'file' AND e.type = 'imports' AND f.path = 'src/pipeline/scan.test.ts'`,
      ).get() as { n: number };
      expect(testEdge.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
