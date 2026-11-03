import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { getFindings, getScopeGraph } from "../db/queries.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-link-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scanFixture(files: Record<string, string>): Promise<Db> {
  const root = mkdtempSync(join(tmpdir(), "repolens-link-"));
  roots.push(root);
  writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await scanRepo({ root, fresh: true });
  return openDb(indexPath(root), { readonly: true });
}

/** All call edges from the file where the caller is located: caller → the file where the callee is located: callee */
function callEdges(db: Db): Array<{ from: string; to: string; confidence: string }> {
  return db.prepare(
    `SELECT fa.path || ':' || sa.name AS "from", fb.path || ':' || sb.name AS "to", e.confidence
     FROM edges e
     JOIN symbols sa ON sa.id = e.src_id JOIN files fa ON fa.id = sa.file_id
     JOIN symbols sb ON sb.id = e.dst_id JOIN files fb ON fb.id = sb.file_id
     WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol'
     ORDER BY 1, 2`,
  ).all() as Array<{ from: string; to: string; confidence: string }>;
}

describe("调用链接的证据边界", () => {
  it("TS 里没有 import 的同名调用不会连到别的文件", async () => {
    const db = await scanFixture({
      "core/db.ts": `
        export function transact(fn: () => void): void {
          const run = wrap(fn);
          run();
        }
        function wrap(fn: () => void): () => void { return fn; }
      `,
      "web/store.ts": "export function run(): void {}\n",
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "core/db.ts:transact", to: "core/db.ts:wrap", confidence: "exact" },
      ]);
    } finally { db.close(); }
  });

  it("沿 export * 与重命名导出追到定义，默认导入也是 exact", async () => {
    const db = await scanFixture({
      "src/impl/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/impl/format.ts": "function fmt(x: number) { return String(x); }\nexport { fmt as format };\n",
      "src/impl/index.ts": 'export * from "./math";\nexport { format as show } from "./format";\n',
      "src/App.tsx": "export default function App() { return null; }\n",
      "src/main.ts": `
        import { add, show } from "./impl";
        import Root from "./App";
        export function main() { show(add(1, 2)); Root(); }
      `,
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "src/main.ts:main", to: "src/App.tsx:App", confidence: "exact" },
        { from: "src/main.ts:main", to: "src/impl/format.ts:fmt", confidence: "exact" },
        { from: "src/main.ts:main", to: "src/impl/math.ts:add", confidence: "exact" },
      ]);
    } finally { db.close(); }
  });

  it("CommonJS 的 require 解构也能建立绑定", async () => {
    const db = await scanFixture({
      "lib/util.js": "function helper() {}\nmodule.exports = { helper };\n",
      "lib/main.js": 'const { helper } = require("./util");\nfunction main() { helper(); }\n',
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "lib/main.js:main", to: "lib/util.js:helper", confidence: "likely" },
      ]);
    } finally { db.close(); }
  });

  it("导出函数里的闭包不算导出，不会成为公共 API", async () => {
    const db = await scanFixture({
      "package.json": JSON.stringify({ name: "closure-fixture", exports: "./src/index.ts" }),
      "src/index.ts": "export function createApi() {\n  const handler = () => 1;\n  return handler();\n}\n",
    });
    try {
      const rows = db.prepare("SELECT name, exported FROM symbols ORDER BY name").all();
      expect(rows).toEqual([
        { name: "createApi", exported: 1 },
        { name: "handler", exported: 0 },
      ]);
    } finally { db.close(); }
  });

  it("Go 的 pkg.Func() 按包目录解析，裸调用只找同包", async () => {
    const db = await scanFixture({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "internal/store/store.go": "package store\n\nfunc Load() string { return helper() }\n",
      "internal/store/helper.go": "package store\n\nfunc helper() string { return \"x\" }\n",
      "internal/other/other.go": "package other\n\nfunc helper() string { return \"y\" }\n",
      "cmd/main.go": [
        "package main",
        "",
        'import "example.com/app/internal/store"',
        "",
        "func main() { store.Load() }",
        "",
      ].join("\n"),
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "cmd/main.go:main", to: "internal/store/store.go:Load", confidence: "exact" },
        { from: "internal/store/store.go:Load", to: "internal/store/helper.go:helper", confidence: "likely" },
      ]);
    } finally { db.close(); }
  });

  it("JSX 元素是对组件的调用：默认导入、具名导入、命名空间成员都能连上，宿主元素不算", async () => {
    const db = await scanFixture({
      "ui/Layout.tsx": "export default function Layout(p: { children: unknown }) { return <main>{p.children}</main>; }\n",
      "ui/Button.tsx": "export function Button(p: { onClick(): void }) { return <button onClick={p.onClick} />; }\n",
      "ui/cards.tsx": "export function Card() { return <div className=\"card\" />; }\n",
      "App.tsx": `
        import Layout from "./ui/Layout";
        import { Button } from "./ui/Button";
        import * as UI from "./ui/cards";
        import { Tooltip } from "some-lib";
        function Header() { return <h1>hi</h1>; }
        export function App() {
          return (
            <Layout>
              <Header />
              <Button onClick={() => {}} {...rest} />
              <UI.Card />
              <Tooltip />
            </Layout>
          );
        }
      `,
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "App.tsx:App", to: "App.tsx:Header", confidence: "exact" },
        { from: "App.tsx:App", to: "ui/Button.tsx:Button", confidence: "exact" },
        { from: "App.tsx:App", to: "ui/Layout.tsx:Layout", confidence: "exact" },
        { from: "App.tsx:App", to: "ui/cards.tsx:Card", confidence: "exact" },
      ]);
      const sites = db.prepare(
        "SELECT callee_name AS callee, call_kind AS kind, argument_texts AS args FROM call_sites WHERE call_kind = 'render' ORDER BY line, callee_name",
      ).all();
      expect(sites).toEqual([
        { callee: "Layout", kind: "render", args: "[]" },
        { callee: "Header", kind: "render", args: "[]" },
        { callee: "Button", kind: "render", args: JSON.stringify(["onClick", "{...rest}"]) },
        { callee: "Card", kind: "render", args: "[]" },
        { callee: "Tooltip", kind: "render", args: "[]" },
      ]);
    } finally { db.close(); }
  });

  it("import type 是纯类型依赖：图上单独标注，也不构成循环依赖", async () => {
    const db = await scanFixture({
      "web/client.ts": 'import type { Report } from "../server/api";\nexport function show(r: Report) { return r; }\n',
      "web/util.ts": "export function fmt(x: string) { return x; }\n",
      "server/api.ts": 'import { fmt } from "../web/util";\nexport type Report = { id: string };\nexport function make() { return fmt("x"); }\n',
    });
    try {
      const graph = getScopeGraph(db, { scope: "dir:." });
      const byPair = Object.fromEntries(graph.edges.map((edge) => [`${edge.source}->${edge.target}`, edge.type]));
      expect(byPair).toEqual({
        "dir:web->dir:server": "references",
        "dir:server->dir:web": "imports",
      });
      expect(getFindings(db, { kind: "cycle" })).toEqual([]);
    } finally { db.close(); }
  });

  it("Python 通配导入给 likely，没有导入证据的同名函数不连", async () => {
    const db = await scanFixture({
      "app/__init__.py": "",
      "app/helpers.py": "def slugify(x):\n    return x\n",
      "app/unrelated.py": "def render(x):\n    return x\n",
      "app/views.py": "from .helpers import *\n\ndef index():\n    slugify('a')\n    render('b')\n",
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "app/views.py:index", to: "app/helpers.py:slugify", confidence: "likely" },
      ]);
    } finally { db.close(); }
  });
});

interface Site {
  file: string;
  callee: string;
  receiver: string | null;
  line: number;
  caller: string | null;
  resolution: string;
  external: string | null;
  target: string | null;
  io: string | null;
}

function sites(db: Db): Site[] {
  return db.prepare(
    `SELECT f.path AS file, c.callee_name AS callee, c.receiver, c.line, caller.name AS caller, c.resolution,
            c.target_name AS external, c.io_kind AS io,
            CASE WHEN t.id IS NULL THEN NULL
                 WHEN t.container IS NULL THEN t.name ELSE t.container || '.' || t.name END AS target
     FROM call_sites c
     JOIN files f ON f.id = c.file_id
     LEFT JOIN symbols caller ON caller.id = c.caller_symbol_id
     LEFT JOIN symbols t ON t.id = c.target_symbol_id`,
  ).all() as Site[];
}

function site(all: readonly Site[], match: Partial<Site>): Site {
  const found = all.filter((s) => Object.entries(match).every(([key, value]) => s[key as keyof Site] === value));
  if (found.length !== 1) throw new Error(`期望 1 个调用点匹配 ${JSON.stringify(match)}，实际 ${found.length} 个`);
  return found[0] as Site;
}

describe("按接收者类型解析方法调用", () => {
  it("构造器、参数标注、类型别名、返回值、接口实现、父类与链式调用", async () => {
    const db = await scanFixture({
      "src/database.ts": `
        import Database from "better-sqlite3";
        export type Db = Database.Database;
        export function openDb(path: string): Db { return new Database(path); }
      `,
      "src/store.ts": `
        import type { Db } from "./database.js";
        export interface Repo { load(id: string): string; }
        export class SqlRepo implements Repo {
          constructor(private readonly db: Db) {}
          load(id: string) { return this.db.prepare("SELECT 1").get(id) as string; }
        }
        export class Base { save() { return 1; } }
        export class Users extends Base {
          run() { return this.save(); }
          find() { return 1; }
        }
        export function makeUsers(): Users { return new Users(); }
      `,
      "src/main.ts": `
        import { openDb } from "./database.js";
        import { makeUsers, type Repo, Users } from "./store.js";
        export function main(repo: Repo, label: string) {
          const db = openDb("x");
          const rows = db.prepare("SELECT * FROM t").all();
          const users = new Users();
          users.find();
          makeUsers().find();
          repo.load("1");
          label.trim();
          [users].forEach((users) => users.find());
          return rows;
        }
      `,
    });
    try {
      const all = sites(db);
      // Alias Db = Database.Database traced to better-sqlite3, recognizing database access by the package name
      expect(site(all, { file: "src/main.ts", callee: "prepare" })).toMatchObject({
        resolution: "external", external: "better-sqlite3", io: "database",
      });
      expect(site(all, { file: "src/main.ts", callee: "all" })).toMatchObject({
        resolution: "external", external: "better-sqlite3",
      });
      // The constructor parameter property `private readonly db: Db` gives the type of this.db
      expect(site(all, { caller: "load", callee: "prepare", receiver: "this.db" })).toMatchObject({
        resolution: "external", external: "better-sqlite3", io: "database",
      });
      expect(site(all, { caller: "load", callee: "get" })).toMatchObject({
        resolution: "external", external: "better-sqlite3",
      });
      expect(site(all, { callee: "find", receiver: "users", line: 8 })).toMatchObject({
        resolution: "exact", target: "Users.find",
      });
      // The return type annotation inferred is only considered likely: the annotation may be broader than the actual return.
      expect(site(all, { callee: "find", receiver: "makeUsers()" })).toMatchObject({
        resolution: "likely", target: "Users.find",
      });
      expect(site(all, { callee: "load", receiver: "repo" })).toMatchObject({
        resolution: "likely", target: "SqlRepo.load",
      });
      expect(site(all, { callee: "save", receiver: "this" })).toMatchObject({ resolution: "exact", target: "Base.save" });
      expect(site(all, { callee: "trim" })).toMatchObject({ resolution: "external", external: "String" });
      // The arrow function parameter 'users' shadows the outer `const users = new Users()`, so the outer type cannot be accessed.
      expect(site(all, { callee: "find", receiver: "users", line: 12 }).resolution).not.toBe("exact");
    } finally { db.close(); }
  });

  it("注册回调的参数归注册方所在的库，集合方法回调里的元素不算", async () => {
    const db = await scanFixture({
      "src/server.ts": `
        import { Hono } from "hono";
        import { List } from "immutable";
        const app = new Hono();
        app.post("/x", async (c) => {
          const body = await c.req.json();
          return c.json(body);
        });
        export function names(xs: List<string>) {
          return xs.map((x) => x.trim());
        }
      `,
    });
    try {
      const all = sites(db);
      expect(site(all, { callee: "json", receiver: "c.req" })).toMatchObject({ resolution: "external", external: "hono" });
      expect(site(all, { callee: "json", receiver: "c" })).toMatchObject({ resolution: "external", external: "hono" });
      expect(site(all, { callee: "map" })).toMatchObject({ resolution: "external", external: "immutable" });
      expect(site(all, { callee: "trim" }).external).toBeNull();
    } finally { db.close(); }
  });
});

describe("内置与 I/O 标注", () => {
  it("语言内置标为外部，注册子命令和 Map 操作不算 I/O，CSS 函数不算调用", async () => {
    const db = await scanFixture({
      "src/cli.ts": `
        import { Command } from "commander";
        const program = new Command();
        program.command("scan").action(() => {});
        const overviewRequests = new Map<string, number>();
        overviewRequests.delete("k");
        setTimeout(() => parseInt("1"), 1);
        const jobs: Array<() => void> = [];
        jobs.push(() => {});
        class Report { deps: string[] = []; filter() { return this; } }
        export function pick(deps: Report["deps"]) { return deps.filter(Boolean); }
      `,
      "src/files.ts": `
        import { readFileSync } from "node:fs";
        export function lines(p: string) {
          const text = readFileSync(p, "utf8");
          return text.split("\\n");
        }
      `,
      "app/main.py": "def run(items):\n    print(len(items))\n    with open('x') as f:\n        return f.read()\n",
      "src/style.css": ":root { --a: 1px; } .x { width: calc(var(--a) * 2); }",
    });
    try {
      const all = sites(db);
      expect(site(all, { callee: "command" })).toMatchObject({ resolution: "external", external: "commander", io: null });
      expect(site(all, { callee: "delete" })).toMatchObject({ resolution: "external", external: "Map", io: null });
      expect(site(all, { callee: "setTimeout" })).toMatchObject({ resolution: "external", external: "setTimeout" });
      expect(site(all, { callee: "parseInt" })).toMatchObject({ resolution: "external" });
      // The function type in the generic parameter does not affect that the outer layer is an Array; Report["deps"] is the type of the field, not Report itself
      expect(site(all, { callee: "push" })).toMatchObject({ resolution: "external", external: "Array" });
      expect(site(all, { callee: "filter" })?.resolution).not.toBe("exact");
      expect(site(all, { callee: "readFileSync" })).toMatchObject({ external: "node:fs", io: "filesystem" });
      // The string read out borrows the name of node:fs, but split doesn't touch files
      expect(site(all, { callee: "split" })).toMatchObject({ resolution: "external", external: "node:fs", io: null });
      expect(site(all, { callee: "print" })).toMatchObject({ resolution: "external", external: "print" });
      expect(site(all, { callee: "len" })).toMatchObject({ resolution: "external", external: "len" });
      expect(site(all, { callee: "open" })).toMatchObject({ resolution: "external", io: "filesystem" });
      expect(all.filter((s) => s.file === "src/style.css")).toEqual([]);
    } finally { db.close(); }
  });

  it("npm 的 open 包是打开浏览器，不是 Python 内置的 open", async () => {
    const db = await scanFixture({
      "src/cli.ts": 'import open from "open";\nexport function launch() { open("http://localhost"); }\n',
    });
    try {
      expect(site(sites(db), { callee: "open" })).toMatchObject({ resolution: "external", external: "open", io: null });
    } finally { db.close(); }
  });
});
