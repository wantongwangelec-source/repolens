import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db/database.js";
import type { ChatContextItemDto, ChatToolStepDto } from "../types.js";
import { readLlmStatus } from "../db/semantic.js";
import { buildChatContext, parseChatRequest, recordChatUsage, streamRepositoryChat } from "./chat.js";

let db: Db | null = null;
const temporaryDirectories: string[] = [];

afterEach(() => {
  db?.close();
  db = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function setupRepo(): { repo: string; db: Db; fileId: number; symbolId: number } {
  const repo = tempDir("repolens-chat-repo-");
  const configHome = tempDir("repolens-chat-config-");
  mkdirSync(join(repo, "src"));
  const source = "// header\n\nexport function run(input) {\n  if (!input) return null;\n  return input.trim();\n}\n";
  writeFileSync(join(repo, "src/run.ts"), source);
  mkdirSync(join(configHome, "repolens"));
  writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
    llm: { baseUrl: "http://llm.test/v1", model: "chat-model", apiKeyEnv: "REPOLENS_CHAT_TEST_KEY", maxRetries: 0 },
  }));
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  vi.stubEnv("REPOLENS_CHAT_TEST_KEY", "test-secret");

  const opened = openDb(join(repo, "index.db"));
  const fileId = Number(opened.prepare(
    `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
     VALUES ('src/run.ts', 'src', 'run.ts', 'typescript', 'source', 6, ?, 'file-hash')`,
  ).run(Buffer.byteLength(source)).lastInsertRowid);
  const symbolId = Number(opened.prepare(
    `INSERT INTO symbols (file_id, name, kind, exported, start_line, end_line, start_byte, end_byte, hash)
     VALUES (?, 'run', 'function', 1, 3, 6, ?, ?, 'sym-hash')`,
  ).run(fileId, source.indexOf("export"), source.lastIndexOf("}") + 1).lastInsertRowid);
  db = opened;
  return { repo, db: opened, fileId, symbolId };
}

describe("parseChatRequest", () => {
  it("要求最后一条是非空的用户消息", () => {
    expect(parseChatRequest(null)).toBeNull();
    expect(parseChatRequest({ messages: [] })).toBeNull();
    expect(parseChatRequest({ messages: [{ role: "assistant", content: "hi" }] })).toBeNull();
    expect(parseChatRequest({ messages: [{ role: "user", content: "   " }] })).toBeNull();
    expect(parseChatRequest({ messages: [{ role: "system", content: "x" }] })).toBeNull();
  });

  it("丢弃不合法的引用，不接受路径形式的 id", () => {
    const parsed = parseChatRequest({
      messages: [{
        role: "user",
        content: "这是做什么的？",
        refs: [
          { kind: "node", id: "sym:12" },
          { kind: "node", id: "file:../../etc/passwd" },
          { kind: "node", id: "dir:src/db" },
          { kind: "quote", text: "  " },
          { kind: "quote", text: "返回结果", nodeId: "file:3", lines: [9, 4] },
          { kind: "view", mode: "hack" },
          { kind: "view", mode: "trace", traceId: "trace:7" },
          { kind: "view", mode: "walk", walk: [{ id: "sym:3", at: "call:9" }, { id: "file:2", at: null }, { id: "sym:4", at: "x" }] },
        ],
      }],
    });
    expect(parsed?.messages[0]?.refs).toEqual([
      { kind: "node", id: "sym:12" },
      { kind: "node", id: "dir:src/db" },
      { kind: "quote", text: "返回结果", nodeId: "file:3", lines: null },
      { kind: "view", mode: "walk", scope: null, expanded: null, walk: [{ id: "sym:3", at: "call:9" }, { id: "sym:4", at: null }] },
    ]);
  });

  it("只保留最近的消息并截断过长内容", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    messages.push({ role: "user", content: "x".repeat(20_000) });
    const parsed = parseChatRequest({ messages });
    expect(parsed?.messages).toHaveLength(24);
    expect(parsed?.messages.at(-1)?.content).toHaveLength(8_000);
  });
});

describe("buildChatContext", () => {
  it("按 id 现读源码并带上可引用的节点 id", () => {
    const { repo, db, symbolId } = setupRepo();
    const context = buildChatContext(db, repo, [
      { role: "user", content: "run 做什么？", refs: [{ kind: "node", id: `sym:${symbolId}` }] },
    ]);
    expect(context.text).toContain(`## 符号 run（id=sym:${symbolId}）`);
    expect(context.text).toContain("3| export function run(input) {");
    expect(context.text).toContain("6| }");
    expect(context.items.map((item) => item.label)).toEqual(["repo", "run"]);
  });

  it("被调用方标注定义文件，调用点行号归到当前文件", () => {
    const { repo, db, symbolId } = setupRepo();
    const utilFile = Number(db.prepare(
      `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
       VALUES ('src/util.ts', 'src', 'util.ts', 'typescript', 'source', 40, 0, 'util-hash')`,
    ).run().lastInsertRowid);
    const trim = Number(db.prepare(
      `INSERT INTO symbols (file_id, name, kind, exported, start_line, end_line, start_byte, end_byte, hash)
       VALUES (?, 'trim', 'function', 1, 30, 32, 0, 0, 'trim-hash')`,
    ).run(utilFile).lastInsertRowid);
    db.prepare(
      `INSERT INTO edges (type, src_kind, src_id, dst_kind, dst_id, confidence, line)
       VALUES ('calls', 'symbol', ?, 'symbol', ?, 'exact', 5)`,
    ).run(symbolId, trim);

    const context = buildChatContext(db, repo, [
      { role: "user", content: "run 调用了什么？", refs: [{ kind: "node", id: `sym:${symbolId}` }] },
    ]);
    expect(context.text).toContain(`trim（id=sym:${trim}，定义在 src/util.ts，本文件 L5 调用）`);
    expect(context.text).not.toContain("src/util.ts:5");
  });

  it("不存在的节点静默跳过，重复引用只展开一次", () => {
    const { repo, db, fileId } = setupRepo();
    const context = buildChatContext(db, repo, [
      { role: "user", content: "a", refs: [{ kind: "node", id: `file:${fileId}` }, { kind: "node", id: "sym:999" }] },
      { role: "assistant", content: "b" },
      { role: "user", content: "c", refs: [{ kind: "node", id: `file:${fileId}` }] },
    ]);
    expect(context.items.map((item) => item.nodeId ?? null)).toEqual([null, `file:${fileId}`]);
    expect(context.text.match(/## 文件 src\/run.ts/g)).toHaveLength(1);
  });
});

describe("streamRepositoryChat", () => {
  it("把上下文放进 system、引用放进用户消息，并流式回传", async () => {
    const { repo, db, fileId, symbolId } = setupRepo();
    let sent: { messages: Array<{ role: string; content: string }>; stream: boolean } | null = null;
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as typeof sent;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"它会[清理输入](node:sym:${symbolId})"}}]}\n\n`));
          controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":8,"total_tokens":108}}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    let items: ChatContextItemDto[] = [];
    let answer = "";
    const done = await streamRepositoryChat(db, repo, {
      messages: [{
        role: "user",
        content: "为什么要 trim？",
        refs: [{ kind: "quote", text: "返回去掉首尾空白的输入", nodeId: `file:${fileId}`, lines: [5, 5] }],
      }],
    }, {
      onContext: (value) => { items = value; },
      onDelta: (text) => { answer += text; },
    });

    expect(answer).toBe(`它会[清理输入](node:sym:${symbolId})`);
    expect(done).toEqual({ model: "chat-model", usage: { requests: 1, inputTokens: 100, outputTokens: 8, totalTokens: 108 } });
    expect(items.map((item) => item.detail)).toContain("L5–5");

    const request = sent as unknown as { messages: Array<{ role: string; content: string }>; stream: boolean };
    expect(request.stream).toBe(true);
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.content).toContain("[显示名](node:ID)");
    expect(request.messages[0]?.content).toContain("5|   return input.trim();");
    expect(request.messages[1]).toEqual({
      role: "user",
      content: `[引用 · id=file:${fileId} L5–5]\n> 返回去掉首尾空白的输入\n\n为什么要 trim？`,
    });

    recordChatUsage(db, repo, done.usage);
    expect(readLlmStatus(db)?.usage.totalTokens).toBe(108);
  });

  function sse(events: unknown[]): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("模型调工具时执行并把结果交回去，直到给出回答", async () => {
    const { repo, db, fileId } = setupRepo();
    writeFileSync(join(repo, "package.json"), '{ "name": "demo", "scripts": { "start": "node src/run.ts" } }\n');
    const bodies: Array<{ messages: Array<Record<string, unknown>>; tools?: Array<{ function: { name: string } }>; tool_choice?: string }> = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(body);
      if (bodies.length === 1) {
        return sse([
          { choices: [{ delta: { content: "我先看看配置。" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"package.json"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "read_file", arguments: '{"path":"../etc/passwd"}' } }] } }] },
          { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
        ]);
      }
      return sse([
        { choices: [{ delta: { content: "启动命令是 `node src/run.ts`。" } }] },
        { choices: [], usage: { prompt_tokens: 80, completion_tokens: 6, total_tokens: 86 } },
      ]);
    });

    const steps: ChatToolStepDto[] = [];
    let answer = "";
    const done = await streamRepositoryChat(db, repo, {
      messages: [{ role: "user", content: "怎么启动？", refs: [{ kind: "node", id: `file:${fileId}` }] }],
    }, {
      onDelta: (text) => { answer += text; },
      onTool: (step) => steps.push(step),
    });

    expect(answer).toBe("我先看看配置。\n\n启动命令是 `node src/run.ts`。");
    expect(done.usage).toEqual({ requests: 2, inputTokens: 130, outputTokens: 16, totalTokens: 146 });
    expect(steps.map((step) => [step.id, step.status])).toEqual([["t1", "running"], ["t1", "done"], ["t2", "running"], ["t2", "error"]]);
    expect(steps[1]).toMatchObject({ tool: "read_file", target: "package.json", nodeId: "raw:package.json", lines: [1, 1] });

    expect(bodies[0]?.tools?.map((tool) => tool.function.name)).toContain("git_log");
    expect(bodies[0]?.tool_choice).toBe("auto");
    expect(String(bodies[0]?.messages[0]?.["content"])).toContain("先用工具去查再作答");
    const followUp = bodies[1]!.messages;
    expect(followUp.at(-3)).toMatchObject({ role: "assistant", content: "我先看看配置。", tool_calls: [{ id: "call_1" }, { id: "call_2" }] });
    expect(followUp.at(-2)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(String(followUp.at(-2)?.["content"])).toContain('1| { "name": "demo"');
    expect(followUp.at(-1)).toEqual({ role: "tool", tool_call_id: "call_2", content: "Error: 非法的路径" });
  });

  it("用户级配置关掉追问工具后只凭初始上下文回答", async () => {
    const { repo, db } = setupRepo();
    const configPath = join(process.env["XDG_CONFIG_HOME"]!, "repolens/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { llm: Record<string, unknown> };
    writeFileSync(configPath, JSON.stringify({ llm: { ...config.llm, chatTools: false } }));
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([{ choices: [{ delta: { content: "ok" } }] }]);
    });
    await streamRepositoryChat(db, repo, { messages: [{ role: "user", content: "hi" }] }, { onDelta: () => {} });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(JSON.stringify(bodies[0])).toContain("上下文里没有的信息就直说没看到");
  });

  it("仓库级配置不能替用户打开网页抓取", async () => {
    const { repo, db } = setupRepo();
    const configPath = join(process.env["XDG_CONFIG_HOME"]!, "repolens/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { llm: Record<string, unknown> };
    writeFileSync(configPath, JSON.stringify({ llm: { ...config.llm, webFetch: false } }));
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({ llm: { webFetch: true, chatTools: true } }));
    const bodies: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return sse([{ choices: [{ delta: { content: "ok" } }] }]);
    });
    await streamRepositoryChat(db, repo, { messages: [{ role: "user", content: "hi" }] }, { onDelta: () => {} });
    const names = bodies[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(names).toContain("read_file");
    expect(names).not.toContain("fetch_url");
  });
});
