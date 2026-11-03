import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOverview, indexPath, openDb } from "@repolens/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoLensMcp } from "./mcp.js";

interface Reply {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let root: string;
let home: string;
let mcp: RepoLensMcp;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "repolens-mcp-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  root = mkdtempSync(join(tmpdir(), "repolens-mcp-"));
  write("package.json", JSON.stringify({ name: "shop", version: "1.0.0" }));
  write("src/store/orders.ts", [
    "export interface Order { id: string; total: number }",
    "export function saveOrder(order: Order): Order {",
    "  return order;",
    "}",
    "export function loadOrder(id: string): Order {",
    "  return { id, total: 0 };",
    "}",
  ].join("\n"));
  write("src/api/routes.ts", [
    'import { saveOrder, type Order } from "../store/orders";',
    "export function createOrder(order: Order) {",
    "  return saveOrder(order);",
    "}",
  ].join("\n"));
  write("src/api/routes.test.ts", [
    'import { expect, it } from "vitest";',
    'import { createOrder } from "./routes";',
    'it("创建订单时原样保存", () => {',
    '  expect(createOrder({ id: "1", total: 3 }).total).toBe(3);',
    "});",
  ].join("\n"));
  mcp = new RepoLensMcp(root, "0.0.0-test");
});

afterEach(async () => {
  await mcp.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, contents: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  return (await mcp.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))) as Reply;
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const reply = await rpc("tools/call", { name, arguments: args });
  expect(reply.error).toBeUndefined();
  return reply.result as unknown as ToolResult;
}

async function text(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await tool(name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return result.content[0]!.text;
}

/** The events of fs.watch are asynchronous: after modifying the file, it polls until it detects the change. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等不到索引刷新");
}

describe("RepoLens MCP", () => {
  it("按 JSON-RPC 握手、列工具；通知不回复，未知方法、未知工具和坏 JSON 各有错误码", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "repolens", version: "0.0.0-test" },
    });
    expect(String(init.result!["instructions"])).toContain("conventions");
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result!["protocolVersion"]).toBe("2025-06-18");

    expect(await mcp.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect((await rpc("ping")).result).toEqual({});

    const listed = (await rpc("tools/list")).result!["tools"] as Array<{ name: string; inputSchema: { type: string } }>;
    expect(listed.map((t) => t.name)).toEqual(
      ["overview", "conventions", "module", "find", "symbol", "boundary", "spec", "findings", "changes", "check"],
    );
    expect(listed.every((t) => t.inputSchema.type === "object")).toBe(true);

    expect((await rpc("resources/list")).error?.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "rm_rf" })).error?.code).toBe(-32602);
    expect(await mcp.receive("{oops")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it("关闭时等握手后在后台补的索引写完再返回", async () => {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    await mcp.close();
    const db = openDb(indexPath(root), { readonly: true });
    try {
      expect(getOverview(db).scannedAt).not.toBe("");
    } finally {
      db.close();
    }
  });

  it("查询带节点 id 方便接着查；改完代码再查看到的是改动之后的结构；同名符号列出候选", async () => {
    expect(await text("overview")).toMatch(/源码 \d+ 行/);

    const symbol = await text("symbol", { symbol: "saveOrder" });
    expect(symbol).toContain("src/store/orders.ts:2-4");
    expect(symbol).toMatch(/调用方（1）：\n {2}createOrder {2}src\/api\/routes\.ts:2 {2}\[sym:\d+\]/);
    expect(symbol).toContain("「创建订单时原样保存」");

    const card = await text("module", { module: "src/store" });
    expect(card).toContain("模块 store（src/store）[dir:src/store]");
    expect(card).toMatch(/saveOrder\(order: Order\): Order {2}src\/store\/orders\.ts:2 {2}外部调用方 1/);
    expect(card).toContain("被依赖：\n  src/api  1 条 import：Order, saveOrder  [dir:src/api]");
    expect(card).toMatch(/interface Order {2}src\/store\/orders\.ts:1 {2}引用文件 1 {2}\[sym:\d+\]/);

    const boundary = await text("boundary", { from: "src/api", to: "src/store" });
    expect(boundary).toContain("src/api/routes.ts:1 → src/store/orders.ts { saveOrder, Order }");
    expect(boundary).toMatch(/saveOrder（function）src\/store\/orders\.ts:2 {2}被调 1 次，1 个调用方/);
    expect(await text("boundary", { from: "src/store", to: "src/api" })).toContain("没有依赖");

    expect(await text("spec", { target: "src/store" })).toContain("「创建订单时原样保存」");
    expect(await text("find", { query: "createOrder" })).toMatch(/createOrder .*\[sym:\d+\]/);

    write("src/store/orders.ts", [
      "export interface Order { id: string; total: number }",
      "export function saveOrder(order: Order): Order {",
      "  return order;",
      "}",
      "export function cancelOrder(id: string): void {}",
    ].join("\n"));
    write("src/api/legacy.ts", "export function createOrder() {}\n");
    await eventually(async () => !(await tool("symbol", { symbol: "cancelOrder" })).isError);

    const ambiguous = await tool("symbol", { symbol: "createOrder" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0]!.text).toContain("「createOrder」有 2 个同名符号");
    expect(ambiguous.content[0]!.text).toMatch(/createOrder（function）src\/api\/legacy\.ts:1 {2}\[sym:\d+\]/);

    const missing = await tool("module", { module: "src/nowhere" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("先用 find 搜一下");
  });

  it("没有约定时说明怎么加；写进规则和依赖锁后，check 拦下新长出来的依赖，conventions 读得到约定", async () => {
    expect(await text("conventions")).toContain("还没有写下约定");
    expect(await text("check")).toContain("没有可检查的约定");

    write(".repolens.json", JSON.stringify({
      rules: [{ name: "存储层不依赖接口层", from: "src/store/**", disallow: ["src/api/**"], reason: "接口层调存储层，反过来就成环了" }],
    }));
    write(".repolens.lock.json", JSON.stringify({
      version: 1,
      level: "directory",
      modules: ["src/api", "src/store"],
      dependencies: [{ from: "src/api", to: "src/store", type: "imports" }],
    }));
    const conventions = await text("conventions");
    expect(conventions).toContain("存储层不依赖接口层：src/store/** 不许依赖 src/api/**");
    expect(conventions).toContain("理由：接口层调存储层，反过来就成环了");
    expect(conventions).toContain("src/api → src/store");
    expect(await text("check")).toContain("约定检查：通过");

    write("src/store/audit.ts", 'import { createOrder } from "../api/routes";\nexport const audit = () => createOrder;\n');
    const report = await text("check");
    expect(report).toContain("约定检查：未通过");
    expect(report).toContain("src/store/audit.ts:1 → src/api/routes.ts");
    expect(report).toContain("✗ src/store → src/api  1 处");

    expect(await text("findings", { kind: "cycle" })).toContain("依赖环");
    const badKind = await tool("findings", { kind: "smell" });
    expect(badKind.isError).toBe(true);
  });

  it("changes 对比基线提交，说出改动做了什么；基线不存在时作为工具错误返回", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");

    write("src/api/routes.ts", [
      'import { loadOrder, saveOrder, type Order } from "../store/orders";',
      "export function createOrder(order: Order) {",
      "  loadOrder(order.id);",
      "  return saveOrder(order);",
      "}",
    ].join("\n"));
    const changes = await text("changes");
    expect(changes).toContain("createOrder：新调 loadOrder");

    const missing = await tool("changes", { base: "no-such-ref" });
    expect(missing.isError).toBe(true);
  });
});
