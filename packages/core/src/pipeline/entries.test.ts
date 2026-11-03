import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { getEntryPoints, getWalkFrame } from "../db/walk.js";
import type { WalkFrameDto } from "../types.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scanFixture(name: string, files: Record<string, string>, pkg: Record<string, unknown> = {}): Promise<Db> {
  const root = mkdtempSync(join(tmpdir(), `repolens-${name}-`));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module", ...pkg }));
  writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await scanRepo({ root, fresh: true });
  return openDb(indexPath(root), { readonly: true });
}

function frameOf(db: Db, id: string | null | undefined): WalkFrameDto {
  const frame = getWalkFrame(db, Number(id?.split(":")[1]));
  if (!frame) throw new Error(`没有 ${id} 的走读帧`);
  return frame;
}

describe("入口识别", () => {
  it("识别 Express 路由，并记下往下能走到的范围与 I/O", async () => {
    const db = await scanFixture("entry-express", {
      "src/server.ts": `
        import express from "express";
        import { loadUser } from "./users.js";
        const app = express();
        export function getUser(req: { params: { id: string } }, res: unknown) {
          return loadUser(req.params.id);
        }
        app.get("/users/:id", getUser);
      `,
      "src/users.ts": `
        const db = { query(sql: string, args: unknown[]) { return args; } };
        export function loadUser(id: string) {
          return db.query("SELECT * FROM users WHERE id = ?", [id]);
        }
      `,
    });
    try {
      const entries = getEntryPoints(db);
      // loadUser and db.query on the object literal are both functions within the repository
      expect(entries[0]).toMatchObject({
        kind: "http", label: "GET /users/:id", method: "GET", route: "/users/:id",
        confidence: "exact", framework: "Express-compatible", fileRole: "source",
        reachSymbols: 2, reachFiles: 1, reachIo: ["database"],
      });
      expect(entries[0]?.symbolId).toMatch(/^sym:/);
    } finally { db.close(); }
  });

  it("只把包入口导出视为公共 API，并要求 command 有 CLI 接收者证据", async () => {
    const db = await scanFixture("entry-scope", {
      "src/index.ts": `
        export function publicTask(): string { return "ok"; }
        const lane = { command(name: string, handler: unknown): void {} };
        const program = { command(name: string, handler: unknown): void {} };
        lane.command("not-a-cli", publicTask);
        program.command("serve", publicTask);
      `,
      "src/internal.ts": `export function internalHelper(): string { return "internal"; }`,
    }, { exports: "./src/index.ts" });
    try {
      const entries = getEntryPoints(db);
      expect(entries.filter((entry) => entry.kind === "public-api").map((entry) => entry.label)).toEqual(["publicTask"]);
      expect(entries.filter((entry) => entry.kind === "cli").map((entry) => entry.label)).toEqual(["CLI serve"]);
    } finally { db.close(); }
  });

  it("内联路由 / CLI 回调合成独立符号，入口可以走读", async () => {
    const db = await scanFixture("entry-inline", {
      "src/api.ts": `
        import { Hono } from "hono";
        import { Command } from "commander";
        import { readFileSync } from "node:fs";

        function loadReport(id: string): string { return readFileSync(id, "utf8"); }

        export function createApi() {
          const app = new Hono();
          app.get("/reports/:id", (c) => {
            return c.json(loadReport(c.req.param("id")));
          });
          app.post("/reports", async (c) => c.json(await c.req.json()));
          return app;
        }

        const program = new Command();
        program
          .command("dump [path]")
          .option("-q, --quiet", "quiet", false)
          .action(async (path: string) => {
            loadReport(path);
          });
      `,
    });
    try {
      const names = (db.prepare("SELECT name FROM symbols ORDER BY start_line").all() as { name: string }[])
        .map((row) => row.name);
      expect(names).toEqual(["loadReport", "createApi", "GET /reports/:id", "POST /reports", "program", "CLI dump"]);

      const entries = getEntryPoints(db);
      const get = entries.find((entry) => entry.label === "GET /reports/:id");
      expect(get).toMatchObject({ kind: "http", confidence: "exact", reachSymbols: 1, reachIo: ["filesystem"] });
      expect(entries.filter((entry) => entry.kind === "cli")).toEqual([
        expect.objectContaining({ label: "CLI dump", confidence: "exact", reachSymbols: 1 }),
      ]);

      // Actual parameters precede the outer call: c.req.param → loadReport → c.json
      expect(frameOf(db, get?.symbolId).calls.map((call) => call.callee)).toEqual(["param", "loadReport", "json"]);
    } finally { db.close(); }
  });
});

describe("单步走读", () => {
  it("同一行按求值顺序、跨行按源码顺序列出调用，并能跨文件步入", async () => {
    const db = await scanFixture("walk-order", {
      "src/main.ts": `
        import { indexPath, openDb } from "./db.js";
        export function run(root: string) {
          const db = openDb(indexPath(root));
          log("opened");
          return db;
        }
        function log(message: string) { console.log(message); }
      `,
      "src/db.ts": `
        import { join } from "node:path";
        import Database from "better-sqlite3";
        export function indexPath(root: string) { return join(root, ".index", "db.sqlite"); }
        export function openDb(path: string) { return new Database(path); }
      `,
    }, { exports: "./src/main.ts" });
    try {
      const entry = getEntryPoints(db).find((item) => item.label === "run");
      const run = frameOf(db, entry?.symbolId);
      expect(run).toMatchObject({ name: "run", filePath: "src/main.ts", language: "typescript" });
      expect(run.calls.map((call) => [call.callee, call.resolution, call.target?.filePath ?? null])).toEqual([
        ["indexPath", "exact", "src/db.ts"],
        ["openDb", "exact", "src/db.ts"],
        ["log", "exact", "src/main.ts"],
      ]);
      expect(run.calls[0]).toMatchObject({ arguments: ["root"], kind: "call" });
      expect(run.calls[1]?.arguments).toEqual(["indexPath(root)"]);
      // Two calls on the same line, each highlighted on its own name
      expect(run.calls[0]?.line).toBe(run.calls[1]?.line);
      expect(run.calls[0]!.column).toBeGreaterThan(run.calls[1]!.column);
      expect(run.calls[0]?.target).toMatchObject({ name: "indexPath", steps: 0 });

      const open = frameOf(db, run.calls[1]?.target?.id);
      expect(open.calls).toEqual([
        expect.objectContaining({ callee: "Database", kind: "new", resolution: "external", external: "better-sqlite3", io: "database" }),
      ]);
      expect(open.reaches).toEqual([{ kind: "database", depth: 0 }]);
      expect(run.reaches).toEqual([{ kind: "database", depth: 1 }]);
      expect(run.calls[1]?.target?.reaches).toEqual([{ kind: "database", depth: 0 }]);
    } finally { db.close(); }
  });

  it("跨行的链式调用每一段都定位到自己的名字", async () => {
    const db = await scanFixture("walk-chain", {
      "src/query.ts": `
        const db = { select() { return this; }, from(t: string) { return this; }, where(c: string) { return this; } };
        export function find() {
          return db
            .select()
            .from("users")
            .where("id = 1");
        }
      `,
    }, { exports: "./src/query.ts" });
    try {
      const entry = getEntryPoints(db).find((item) => item.label === "find");
      const calls = frameOf(db, entry?.symbolId).calls;
      expect(calls.map((call) => [call.callee, call.line])).toEqual([["select", 5], ["from", 6], ["where", 7]]);
      expect(calls.every((call) => call.column === 13)).toBe(true);
    } finally { db.close(); }
  });

  it("推断出的方法落点标为 likely，并保留跨文件的目标", async () => {
    const db = await scanFixture("walk-likely", {
      "src/service.ts": `
        const db = { query(sql: string) { return sql; } };
        export class UserService {
          loadUser(id: string) {
            return db.query("SELECT * FROM users");
          }
        }
      `,
      "src/server.ts": `
        import express from "express";
        import { UserService } from "./service.js";
        const app = express();
        function makeService() { return new UserService(); }
        const service = makeService();
        function getUser(req: { params: { id: string } }) {
          return service.loadUser(req.params.id);
        }
        app.get("/users/:id", getUser);
      `,
    });
    try {
      const route = getEntryPoints(db).find((entry) => entry.kind === "http");
      const [call] = frameOf(db, route?.symbolId).calls;
      expect(call).toMatchObject({
        callee: "loadUser", receiver: "service", resolution: "likely", arguments: ["req.params.id"],
        target: expect.objectContaining({ name: "UserService.loadUser", filePath: "src/service.ts", steps: 1 }),
      });
      expect(call?.target?.reaches).toEqual([{ kind: "database", depth: 0 }]);
    } finally { db.close(); }
  });

  it("落不到仓库里的调用说明原因，并区分语言内置和外部库", async () => {
    const db = await scanFixture("walk-reasons", {
      "src/i18n.ts": "export function useT() { return (key: string) => key; }\n",
      "src/view.ts": `
        import { useState } from "react";
        import { join } from "node:path";
        import { useT } from "./i18n.js";
        function getThing() { return {} as any; }
        export function makeStore(set: (v: number) => void) {
          return { reset() { set(0); } };
        }
        export function load(cfg) { cfg.read(); }
        export function view({ onClose }: { onClose: () => void }, items: unknown) {
          const t = useT();
          const [open, setOpen] = useState(false);
          t("title");
          onClose();
          setOpen(!open);
          items.foo();
          const thing = getThing();
          thing.baz();
          getThing().bar();
          getThing().then(() => 1);
          JSON.parse("1");
          join("a", "b");
        }
      `,
    });
    try {
      const symbol = db.prepare("SELECT id FROM symbols WHERE name = 'view'").get() as { id: number };
      const byCallee = new Map(frameOf(db, `sym:${symbol.id}`).calls.map((call) => [call.callee, call]));
      expect(byCallee.get("t")?.unresolved).toEqual({ kind: "function-value", source: "useT()" });
      expect(byCallee.get("setOpen")?.unresolved).toEqual({ kind: "function-value", source: "useState()", destructured: true });
      expect(byCallee.get("onClose")?.unresolved).toEqual({ kind: "callback" });
      expect(byCallee.get("foo")?.unresolved).toEqual({ kind: "untyped" });
      expect(byCallee.get("baz")?.unresolved).toEqual({ kind: "untyped", source: "getThing()" });
      const load = db.prepare("SELECT id FROM symbols WHERE name = 'load'").get() as { id: number };
      expect(frameOf(db, `sym:${load.id}`).calls[0]?.unresolved).toEqual({ kind: "untyped", param: true });
      expect(byCallee.get("bar")?.unresolved).toEqual({ kind: "chained" });
      expect(byCallee.get("then")).toMatchObject({ resolution: "external", external: "Promise", builtin: true });
      // set is a parameter of the outer makeStore, reset does not have it in its own parameter list
      const reset = db.prepare("SELECT id FROM symbols WHERE name = 'reset'").get() as { id: number };
      expect(frameOf(db, `sym:${reset.id}`).calls[0]?.unresolved).toEqual({ kind: "callback" });
      expect(byCallee.get("parse")).toMatchObject({ resolution: "external", external: "JSON", builtin: true });
      expect(byCallee.get("join")).toMatchObject({ resolution: "external", external: "node:path" });
      expect(byCallee.get("join")?.builtin).toBeUndefined();
    } finally { db.close(); }
  });

  it("多个同名实现时列出候选，不替用户挑一个", async () => {
    const db = await scanFixture("walk-ambiguous", {
      "src/a.ts": `export class Circle { draw() { return 1; } }`,
      "src/b.ts": `export class Square { draw() { return 2; } }`,
      "src/main.ts": `
        import { Circle } from "./a.js";
        import { Square } from "./b.js";
        export function paint(shape: Circle | Square) { return shape.draw(); }
      `,
    }, { exports: "./src/main.ts" });
    try {
      const entry = getEntryPoints(db).find((item) => item.label === "paint");
      const [call] = frameOf(db, entry?.symbolId).calls;
      expect(call?.resolution).toBe("ambiguous");
      expect(call?.candidates?.map((item) => item.name).sort()).toEqual(["Circle.draw", "Square.draw"]);
    } finally { db.close(); }
  });
});
