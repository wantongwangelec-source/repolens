import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { getScopeGraph, getSymbolDetail } from "../db/queries.js";
import { requestSegments, routeSegments } from "./http-links.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
let db: Db | null = null;
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-http-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  db?.close();
  db = null;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["web", "server"] }),
  "web/package.json": JSON.stringify({ name: "web" }),
  "server/package.json": JSON.stringify({ name: "server" }),
  "server/src/app.ts": [
    'import { Hono } from "hono";',
    "const api = new Hono();",
    'api.get("/findings", (c) => c.json(loadFindings()));',
    'api.get("/repos/:id", (c) => c.json({}));',
    'api.delete("/repos/:id", (c) => c.json({}));',
    'api.get("/notes", (c) => c.json([]));',
    'api.post("/notes", (c) => c.json({}));',
    "const app = new Hono();",
    'app.route("/api", api);',
    "function loadFindings() { return []; }",
    "export default app;",
  ].join("\n"),
  "web/src/client.ts": [
    'const BASE = "/api";',
    "async function get<T>(path: string): Promise<T> {",
    "  const response = await fetch(`${BASE}${path}`);",
    "  return (await response.json()) as T;",
    "}",
    "async function send<T>(method: string, path: string, body?: unknown): Promise<T> {",
    "  const response = await fetch(`${BASE}${path}`, { method, body: JSON.stringify(body) });",
    "  return (await response.json()) as T;",
    "}",
    "export const api = {",
    '  findings: () => get<unknown[]>("/findings"),',
    "  repo: (id: string) => get<unknown>(`/repos/${encodeURIComponent(id)}`),",
    "  forgetRepo: async (id: string) => { await fetch(`${BASE}/repos/${id}`, { method: \"DELETE\" }); },",
    '  addNote: (text: string) => send("POST", "/notes", { text }),',
    '  missing: () => get("/nothing/here"),',
    "};",
  ].join("\n"),
  "web/src/tables.ts": [
    'export const LOADERS = { ts: () => import("./client"), tsx: () => import("./Panel") };',
    'export const EN = { "{count} 个文件": (p: { count: number }) => `${p.count} files` };',
    'export const bridge = { "repo:pick": () => Promise.resolve(null) };',
  ].join("\n"),
  "web/src/Panel.tsx": [
    'import { memo } from "react";',
    'import { api } from "./client";',
    "export const Panel = memo(function Panel() {",
    "  void api.findings();",
    "  return <Row />;",
    "});",
    "function Row() { return <div />; }",
  ].join("\n"),
};

async function scanned(): Promise<Db> {
  const root = mkdtempSync(join(tmpdir(), "repolens-http-"));
  roots.push(root);
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await scanRepo({ root, fresh: true, structureOnly: true });
  db = openDb(indexPath(root), { readonly: true });
  return db;
}

function calls(db: Db, where: string): Array<{ from: string; to: string; confidence: string; kind: string | null }> {
  return db.prepare(
    `SELECT COALESCE(s.container || '.', '') || s.name AS "from", t.name AS "to", e.confidence, e.call_kind AS kind
     FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols t ON t.id = e.dst_id
     WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol' AND ${where}
     ORDER BY 1, 2`,
  ).all() as Array<{ from: string; to: string; confidence: string; kind: string | null }>;
}

describe("前后端 HTTP 连线", () => {
  it("前端请求按路径和方法连到后端路由处理器，挂载前缀和 BASE 前缀都不影响", async () => {
    const db = await scanned();
    expect(calls(db, "e.call_kind = 'http'")).toEqual([
      { from: "api.addNote", to: "POST /notes", confidence: "likely", kind: "http" },
      { from: "api.findings", to: "GET /findings", confidence: "likely", kind: "http" },
      { from: "api.forgetRepo", to: "DELETE /repos/:id", confidence: "likely", kind: "http" },
      { from: "api.repo", to: "GET /repos/:id", confidence: "likely", kind: "http" },
    ]);

    const edges = getScopeGraph(db, { scope: "dir:." }).edges.map((e) => `${e.source} ${e.type} ${e.target}`);
    expect(edges).toContain("pkg:web http pkg:server");

    const handler = db.prepare("SELECT id FROM symbols WHERE name = 'GET /findings'").get() as { id: number };
    expect(getSymbolDetail(db, handler.id)?.callers).toEqual([
      expect.objectContaining({ name: "api.findings", confidence: "likely", http: true }),
    ]);
  });

  it("对象字面量里的函数和 memo 包裹的组件成为符号，调用能沿 import 找到它们", async () => {
    const db = await scanned();
    const symbols = db.prepare(
      `SELECT COALESCE(container || '.', '') || name AS name, kind FROM symbols
       WHERE file_id IN (SELECT id FROM files WHERE path LIKE 'web/%') AND kind IN ('function', 'method') ORDER BY 1`,
    ).all();
    expect(symbols).toEqual([
      { name: "Panel", kind: "function" },
      { name: "Row", kind: "function" },
      { name: "api.addNote", kind: "method" },
      { name: "api.findings", kind: "method" },
      { name: "api.forgetRepo", kind: "method" },
      { name: "api.missing", kind: "method" },
      { name: "api.repo", kind: "method" },
      { name: "bridge.repo:pick", kind: "method" },
      { name: "get", kind: "function" },
      { name: "send", kind: "function" },
    ]);
    expect(calls(db, "s.name = 'Panel'")).toEqual([
      { from: "Panel", to: "Row", confidence: "exact", kind: "render" },
      { from: "Panel", to: "findings", confidence: "exact", kind: "method" },
    ]);
  });

  it("路径解析：参数段、前缀插值、查询串和整段 URL", () => {
    expect(routeSegments("/repos/:id/scan")).toEqual(["repos", null, "scan"]);
    expect(routeSegments("/users/{id}")).toEqual(["users", null]);
    expect(routeSegments("/api/*")).toBeNull();
    expect(requestSegments('"/findings"')).toEqual(["findings"]);
    expect(requestSegments("`${BASE}/repos/${id}/scan`")).toEqual(["repos", null, "scan"]);
    expect(requestSegments("`${BASE}/chat${query}`")).toEqual(["chat"]);
    expect(requestSegments('"https://api.example.com/v1/users?page=2"')).toEqual(["v1", "users"]);
    expect(requestSegments('BASE + "/notes"')).toEqual(["notes"]);
    expect(requestSegments("`${BASE}${path}${query}`")).toBeNull();
    expect(requestSegments('"not a path"')).toBeNull();
    expect(requestSegments('"./relative/file"')).toBeNull();
  });
});
