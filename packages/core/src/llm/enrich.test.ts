import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { scanRepo } from "../pipeline/scan.js";
import { getFileDetail, getSymbolDetail, symbolKey } from "../db/queries.js";
import { getCachedSemantic, putCachedSemantic } from "../db/semantic.js";
import {
  dropSemanticsFromOutdatedInput,
  generateFileSummary,
  generateSymbolSemantics,
  semanticInputOutdated,
} from "./enrich.js";

let db: Db | null = null;
const temporaryDirectories: string[] = [];

afterEach(() => {
  db?.close();
  db = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

describe("generateFileSummary", () => {
  it.each([
    ["零字节", ""],
    ["仅空白", "  \n\t\n"],
  ])("%s文件不调用 LLM", async (_label, content) => {
    const repo = tempDir("repolens-empty-file-repo-");
    const configHome = tempDir("repolens-empty-file-config-");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/empty.ts"), content);
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      llm: {
        model: "should-not-run",
        apiKeyEnv: "REPOLENS_MISSING_EMPTY_FILE_KEY",
      },
    }));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("REPOLENS_MISSING_EMPTY_FILE_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    db = openDb(join(repo, "index.db"));
    const inserted = db.prepare(
      `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "src/empty.ts", "src", "empty.ts", "typescript", "source",
      content === "" ? 0 : content.split("\n").length, Buffer.byteLength(content), "empty-hash",
    );

    await expect(generateFileSummary(db, repo, Number(inserted.lastInsertRowid), { force: true }))
      .resolves.toMatchObject({
        summary: null, shortSummary: null, pseudocode: null,
        skipReason: "empty-file", generated: false, cacheHit: false,
        usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("生成详细/单句摘要和文件伪代码，并补齐只有摘要的旧缓存", async () => {
    const repo = tempDir("repolens-summary-repo-");
    const configHome = tempDir("repolens-summary-config-");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/example.ts"), "export function run() { return 'ok'; }\n");
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      llm: {
        baseUrl: "http://llm.test/v1",
        model: "test-model",
        apiKeyEnv: "REPOLENS_ENRICH_TEST_KEY",
        maxRetries: 0,
      },
    }));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("REPOLENS_ENRICH_TEST_KEY", "test-secret");

    db = openDb(join(repo, "index.db"));
    const inserted = db.prepare(
      `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("src/example.ts", "src", "example.ts", "typescript", "source", 1, 39, "file-hash");
    const fileId = Number(inserted.lastInsertRowid);
    putCachedSemantic(db, {
      targetKind: "file", targetKey: "src/example.ts", flavor: "summary-v2", lang: "zh",
      content: "旧缓存只有详细摘要", sourceHash: "file-hash", model: "test-model",
    });

    // There was already a detailed summary when upgrading from the previous version, but the model still needs to be called once to complete the Tooltip and pseudocode.
    expect(getFileDetail(db, fileId)).toMatchObject({
      summary: "用途：旧缓存只有详细摘要", shortSummary: null, pseudocode: null,
    });

    const calls: Array<{ system: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      calls.push({
        system: body.messages.find((message) => message.role === "system")?.content ?? "",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const summary = calls.length === 1
        ? "用途：处理请求。&#x20;\n\n核心概念：Span（一次可追踪的操作）。&nbsp;\n\n工作方式：接收输入并返回结果。"
        : "用途：这是手动刷新后生成的新摘要。";
      const shortSummary = calls.length === 1 ? "处理请求并返回结果。" : "刷新后的简短摘要。";
      const pseudocode = calls.length === 1
        ? "函数 run：\n  返回 ok"
        : "函数 run：\n  返回刷新后的结果";
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ summary, shortSummary, pseudocode }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const first = await generateFileSummary(db, repo, fileId);
    expect(first).toMatchObject({
      generated: true, cacheHit: false, model: "test-model",
      summary: "用途：处理请求。\n\n核心概念：\n- Span（一次可追踪的操作）。\n\n工作方式：\n1. 接收输入并返回结果。",
      shortSummary: "处理请求并返回结果。",
      pseudocode: "1. 函数 run：\n  - 返回 ok",
    });
    expect(first.summary).not.toContain("&#x20;");
    expect(first.summary).not.toContain("&nbsp;");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer test-secret");
    expect(calls[0]?.system).toContain("purpose");
    expect(calls[0]?.system).toContain("keyConcepts");
    expect(calls[0]?.system).toContain("专业术语首次出现时");
    expect(calls[0]?.system).toContain("为什么需要");
    expect(calls[0]?.system).toContain("不要暗示耗时统计");
    expect(calls[0]?.system).toContain("文件整体");
    expect(calls[0]?.system).toContain("主要导出");
    expect(calls[0]?.system).toContain("shortSummary");

    expect(getCachedSemantic(
      db, "file", "src/example.ts", "summary-v2", "zh", "file-hash", "test-model",
    )?.content).toBe(first.summary);
    expect(getCachedSemantic(
      db, "file", "src/example.ts", "tooltip-summary", "zh", "file-hash", "test-model",
    )?.content).toBe(first.shortSummary);
    expect(getCachedSemantic(
      db, "file", "src/example.ts", "pseudocode", "zh", "file-hash", "test-model",
    )?.content).toBe(first.pseudocode);
    expect(getFileDetail(db, fileId)).toMatchObject({
      summary: first.summary, shortSummary: first.shortSummary, pseudocode: first.pseudocode,
    });

    const second = await generateFileSummary(db, repo, fileId);
    expect(second).toMatchObject({
      generated: false, cacheHit: true, summary: first.summary,
      shortSummary: first.shortSummary, pseudocode: first.pseudocode,
    });
    expect(calls).toHaveLength(1);

    const refreshed = await generateFileSummary(db, repo, fileId, { force: true });
    expect(refreshed).toMatchObject({
      generated: true, cacheHit: false, summary: "用途：这是手动刷新后生成的新摘要。",
      shortSummary: "刷新后的简短摘要。",
      pseudocode: "1. 函数 run：\n  - 返回刷新后的结果",
    });
    expect(calls).toHaveLength(2);
    expect(getFileDetail(db, fileId)).toMatchObject({
      summary: refreshed.summary, shortSummary: refreshed.shortSummary, pseudocode: refreshed.pseudocode,
    });
  });
});

describe("generateSymbolSemantics", () => {
  it("把带绝对行号的源码交给模型，并缓存校验过的步骤行号", async () => {
    const repo = tempDir("repolens-symbol-repo-");
    const configHome = tempDir("repolens-symbol-config-");
    mkdirSync(join(repo, "src"));
    // 中文让 tree-sitter 的字符串下标与 UTF-8 字节错开，按字节切片会取错源码
    const source = "// 头部注释\n\nexport function run(input) {\n  if (!input) return null;\n  return input.trim();\n}\n";
    writeFileSync(join(repo, "src/run.ts"), source);
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      llm: { baseUrl: "http://llm.test/v1", model: "test-model", apiKeyEnv: "REPOLENS_SYMBOL_TEST_KEY", maxRetries: 0 },
    }));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("REPOLENS_SYMBOL_TEST_KEY", "test-secret");

    db = openDb(join(repo, "index.db"));
    const fileId = Number(db.prepare(
      `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
       VALUES ('src/run.ts', 'src', 'run.ts', 'typescript', 'source', 6, ?, 'file-hash')`,
    ).run(Buffer.byteLength(source)).lastInsertRowid);
    const startByte = source.indexOf("export");
    const symbolId = Number(db.prepare(
      `INSERT INTO symbols (file_id, name, kind, exported, start_line, end_line, start_byte, end_byte, hash)
       VALUES (?, 'run', 'function', 1, 3, 6, ?, ?, 'sym-hash')`,
    ).run(fileId, startByte, source.lastIndexOf("}") + 1).lastInsertRowid);

    let sentSource = "";
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      sentSource = (JSON.parse(body.messages.find((m) => m.role === "user")?.content ?? "{}") as {
        symbol: { source: string };
      }).symbol.source;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: { purpose: "清理输入。", keyConcepts: [], workflow: [], notes: [] },
              shortSummary: "清理输入字符串。",
              pseudocode: [
                { step: "输入为空时返回 null", lines: [4, 4] },
                { step: "返回去掉首尾空白的输入", lines: [5, 99], details: [{ text: "越界行", lines: [40, 41] }] },
              ],
            }),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await generateSymbolSemantics(db, repo, symbolId);
    expect(sentSource.split("\n")[0]).toBe("3| export function run(input) {");
    expect(sentSource.split("\n").at(-1)).toBe("6| }");
    const expectedSteps = [
      { text: "输入为空时返回 null", lines: [4, 4], children: [] },
      { text: "返回去掉首尾空白的输入", lines: [5, 6], children: [{ text: "越界行", lines: null, children: [] }] },
    ];
    expect(result).toMatchObject({
      generated: true,
      pseudocode: "1. 输入为空时返回 null\n2. 返回去掉首尾空白的输入\n  - 越界行",
      pseudocodeSteps: expectedSteps,
    });
    expect(getSymbolDetail(db, symbolId)?.pseudocodeSteps).toEqual(expectedSteps);
    await expect(generateSymbolSemantics(db, repo, symbolId)).resolves.toMatchObject({
      cacheHit: true, pseudocodeSteps: expectedSteps,
    });
  });
});

describe("dropSemanticsFromOutdatedInput", () => {
  it("只清掉源码里有超长行的文件和符号的缓存，其余照常可用", () => {
    const repo = tempDir("repolens-outdated-input-repo-");
    const blob = "A".repeat(500);
    const files: Record<string, string> = {
      "demo.ipynb": `{\n "image/png": "${blob}"\n}\n`,
      "src/mixed.py": `def short():\n    return 1\n\ndef blob():\n    return "${blob}"\n`,
      "src/plain.ts": "export const ok = 1;\n",
    };
    mkdirSync(join(repo, "src"));
    db = openDb(join(repo, "index.db"));
    const fileIds = new Map<string, number>();
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(repo, path), content);
      fileIds.set(path, Number(db.prepare(
        `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
         VALUES (?, ?, ?, 'other', 'source', 3, ?, 'hash')`,
      ).run(path, path.includes("/") ? "src" : "", path.split("/").at(-1), content.length).lastInsertRowid));
    }
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, exported, start_line, end_line, start_byte, end_byte, hash)
       VALUES (?, ?, 'function', 0, ?, ?, 0, 0, 'hash')`,
    );
    insertSymbol.run(fileIds.get("src/mixed.py"), "short", 1, 2);
    insertSymbol.run(fileIds.get("src/mixed.py"), "blob", 4, 5);

    const shortKey = symbolKey("src/mixed.py", null, "short", 1);
    const blobKey = symbolKey("src/mixed.py", null, "blob", 4);
    const targets = [
      ["file", "demo.ipynb"], ["file", "src/mixed.py"], ["file", "src/plain.ts"],
      ["symbol", shortKey], ["symbol", blobKey],
    ] as const;
    const cache = (kind: "file" | "symbol", key: string) =>
      getCachedSemantic(db!, kind, key, "pseudocode", "zh")?.content ?? null;
    for (const [targetKind, targetKey] of targets) {
      putCachedSemantic(db, {
        targetKind, targetKey, flavor: "pseudocode", lang: "zh",
        content: `1. ${targetKey}`, sourceHash: "hash", model: "test-model",
      });
    }

    expect(semanticInputOutdated(db)).toBe(true);
    dropSemanticsFromOutdatedInput(db, repo);
    expect(cache("file", "demo.ipynb")).toBeNull();
    expect(cache("file", "src/mixed.py")).toBeNull();
    expect(cache("symbol", blobKey)).toBeNull();
    expect(cache("file", "src/plain.ts")).toBe("1. src/plain.ts");
    expect(cache("symbol", shortKey)).toBe(`1. ${shortKey}`);
    expect(semanticInputOutdated(db)).toBe(false);

    // Only do it once: the result regenerated according to the new input cannot be deleted again
    putCachedSemantic(db, {
      targetKind: "file", targetKey: "demo.ipynb", flavor: "pseudocode", lang: "zh",
      content: "1. 新结果", sourceHash: "hash", model: "test-model",
    });
    dropSemanticsFromOutdatedInput(db, repo);
    expect(cache("file", "demo.ipynb")).toBe("1. 新结果");
  });
});

describe("架构分层", () => {
  it("分层请求带上模块间依赖方向、外部库、入口和导出；单包仓库沿 src 下钻到有分叉的一层", async () => {
    const repo = tempDir("repolens-layers-repo-");
    const configHome = tempDir("repolens-layers-config-");
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "app", type: "module" }),
      "src/ui/App.tsx": 'import React from "react";\nimport { load } from "../api/client";\nexport function App() { return React.createElement("div", null, load()); }\n',
      "src/api/client.ts": 'import type { Row } from "../db/types";\nimport { query } from "../db/store";\nexport function load(): Row[] { return query(); }\n',
      "src/api/routes.ts": 'import { Hono } from "hono";\nimport { load } from "./client";\nconst app = new Hono();\napp.get("/rows", (c) => c.json(load()));\nexport default app;\n',
      "src/db/store.ts": 'import Database from "better-sqlite3";\nexport function query() { new Database(":memory:"); return []; }\n',
      "src/db/types.ts": "export type Row = { id: string };\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      llm: { baseUrl: "http://llm.test/v1", model: "test-model", apiKeyEnv: "REPOLENS_LAYERS_TEST_KEY", maxRetries: 0 },
    }));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("REPOLENS_LAYERS_TEST_KEY", "test-secret");

    let architecture: { allowedNodes: Array<Record<string, unknown>>; dependencies: unknown[] } | null = null;
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages.find((m) => m.role === "user")?.content ?? "{}";
      let content: unknown = { items: [] };
      if (system.includes("代码架构分析器")) {
        architecture = JSON.parse(user) as typeof architecture;
        content = {
          summary: "一个三层的小应用。",
          layers: [
            { name: "界面", description: "React 组件", nodeIds: ["dir:src/ui"] },
            { name: "接口", description: "HTTP 路由", nodeIds: ["dir:src/api", "dir:nope"] },
            { name: "存储", description: "SQLite", nodeIds: ["dir:src/db"] },
          ],
        };
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await scanRepo({ root: repo, fresh: true });

    expect(architecture).not.toBeNull();
    const nodes = architecture!.allowedNodes.map(({ id, files: count, exports, externals, entries }) => ({ id, files: count, exports, externals, entries }));
    expect(nodes).toEqual(expect.arrayContaining([
      { id: "dir:src/ui", files: 1, exports: ["App"], externals: ["react"], entries: expect.any(Array) },
      { id: "dir:src/api", files: 2, exports: ["load"], externals: ["hono"], entries: expect.arrayContaining(["http"]) },
      { id: "dir:src/db", files: 2, exports: expect.arrayContaining(["query", "Row"]), externals: ["better-sqlite3"], entries: expect.any(Array) },
    ]));
    expect(nodes).toHaveLength(3);
    expect(architecture!.dependencies).toEqual(expect.arrayContaining([
      { from: "dir:src/ui", to: "dir:src/api", count: 1, kind: "import" },
      { from: "dir:src/api", to: "dir:src/db", count: 1, kind: "import" },
      { from: "dir:src/api", to: "dir:src/db", count: 1, kind: "type" },
    ]));
    expect(architecture!.dependencies).toHaveLength(3);

    db = openDb(indexPath(repo), { readonly: true });
    const layers = db.prepare("SELECT name, members FROM layers ORDER BY ordinal").all();
    expect(layers).toEqual([
      { name: "界面", members: '["dir:src/ui"]' },
      { name: "接口", members: '["dir:src/api"]' },
      { name: "存储", members: '["dir:src/db"]' },
    ]);
  });
});
