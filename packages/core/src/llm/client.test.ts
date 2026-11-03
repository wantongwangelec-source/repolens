import { describe, expect, it } from "vitest";
import type { LlmConfig } from "../types.js";
import {
  LlmUnavailableError,
  OpenAiCompatibleClient,
  llmUnavailableReason,
  parseJsonResponse,
} from "./client.js";

const config: LlmConfig = {
  baseUrl: "http://127.0.0.1:8317/v1",
  model: "test-model",
  interactiveModel: null,
  apiKeyEnv: "REPOLENS_TEST_API_KEY_THAT_DOES_NOT_EXIST",
  maxConcurrency: 2,
  temperature: 0.1,
  reasoningEffort: "low",
  maxOutputTokens: 100,
  requestTimeoutMs: 1_000,
  maxRetries: 1,
  scanBatchSize: 4,
  scanMaxCalls: 10,
  outputLanguage: "zh",
  enabled: true,
  chatTools: true,
  webFetch: true,
};

describe("llmUnavailableReason", () => {
  it("区分关闭、缺 key 与无需鉴权", () => {
    expect(llmUnavailableReason({ ...config, enabled: false })).toBe("LLM 已在配置中关闭");
    expect(llmUnavailableReason(config)).toBe(`未设置环境变量 ${config.apiKeyEnv}`);
    expect(llmUnavailableReason(config, "explicit")).toBeNull();
    expect(llmUnavailableReason({ ...config, apiKeyEnv: "" })).toBeNull();
  });
});

describe("OpenAiCompatibleClient", () => {
  it("在需要 key 但环境变量缺失时优雅拒绝", () => {
    expect(() => new OpenAiCompatibleClient(config)).toThrow(LlmUnavailableError);
  });

  it("支持无需鉴权的 Ollama 风格配置", async () => {
    const calls: RequestInit[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"summary":"ok"}\n```' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new OpenAiCompatibleClient(
      { ...config, apiKeyEnv: "", baseUrl: "http://localhost:11434/v1" },
      { fetch: fetch as typeof globalThis.fetch },
    );
    const result = await client.completeJson<{ summary: string }>("system", "user");
    expect(result.data.summary).toBe("ok");
    expect(result.usage).toEqual({ requests: 1, inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect((calls[0]?.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("对 429 重试且不在错误中泄露鉴权头", async () => {
    let count = 0;
    const fetch = async () => {
      count++;
      if (count === 1) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    };
    const client = new OpenAiCompatibleClient(config, { apiKey: "super-secret", fetch: fetch as typeof globalThis.fetch });
    await expect(client.completeJson<{ ok: boolean }>("s", "u")).resolves.toMatchObject({ data: { ok: true } });
    expect(count).toBe(2);
  });
});

function eventStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAiCompatibleClient.streamChat", () => {
  const turns = [{ role: "user" as const, content: "hi" }];

  it("按行解析 SSE，容忍被拆开的 chunk，并读取末尾 usage", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return eventStream([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choi',
        'ces":[{"delta":{"content":"好"}}]}\r\n\r\n',
        ': keep-alive\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ]);
    };
    const client = new OpenAiCompatibleClient(config, { apiKey: "k", fetch: fetch as typeof globalThis.fetch });
    const deltas: string[] = [];
    const result = await client.streamChat(turns, { onDelta: (text) => deltas.push(text) });
    expect(deltas).toEqual(["你", "好"]);
    expect(result).toEqual({
      content: "你好",
      usage: { requests: 1, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      toolCalls: [],
      toolsRejected: false,
    });
    expect(sent[0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, messages: turns });
    expect(sent[0]).not.toHaveProperty("tools");
  });

  const readFileTool = {
    type: "function" as const,
    function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
  };

  it("把分片到达的函数调用按 index 拼回完整参数", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return eventStream([
        'data: {"choices":[{"delta":{"content":"先看看","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"git_log","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    };
    const client = new OpenAiCompatibleClient(config, { apiKey: "k", fetch: fetch as typeof globalThis.fetch });
    const result = await client.streamChat(turns, { onDelta: () => {}, tools: [readFileTool] });
    expect(result.content).toBe("先看看");
    expect(result.toolCalls).toEqual([
      { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      { id: "call_b", type: "function", function: { name: "git_log", arguments: "{}" } },
    ]);
    expect(sent[0]).toMatchObject({ tools: [readFileTool], tool_choice: "auto" });
  });

  it("模型不支持函数调用时去掉工具重发，并告知调用方", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("tools" in body) {
        return new Response(JSON.stringify({ error: { message: "model does not support tools" } }), { status: 400 });
      }
      return eventStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
    };
    const client = new OpenAiCompatibleClient({ ...config, maxRetries: 0 }, { apiKey: "k", fetch: fetch as typeof globalThis.fetch });
    const result = await client.streamChat(turns, { onDelta: () => {}, tools: [readFileTool] });
    expect(result).toMatchObject({ content: "ok", toolCalls: [], toolsRejected: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("tools");
  });

  it("网关忽略 stream 参数时退化为一次性 JSON", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "整段回答" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    const client = new OpenAiCompatibleClient(config, { apiKey: "k", fetch: fetch as typeof globalThis.fetch });
    const deltas: string[] = [];
    await expect(client.streamChat(turns, { onDelta: (text) => deltas.push(text) }))
      .resolves.toMatchObject({ content: "整段回答" });
    expect(deltas).toEqual(["整段回答"]);
  });

  it("不认识 stream_options 的网关去掉该字段重发一次", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("stream_options" in body) {
        return new Response(JSON.stringify({ error: { message: "Unrecognized argument: stream_options" } }), { status: 400 });
      }
      return eventStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
    };
    const client = new OpenAiCompatibleClient({ ...config, maxRetries: 0 }, { apiKey: "k", fetch: fetch as typeof globalThis.fetch });
    await expect(client.streamChat(turns, { onDelta: () => {} })).resolves.toMatchObject({ content: "ok" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("stream_options");
  });

  it("调用方取消时中止请求且不重试", async () => {
    let calls = 0;
    const fetch = (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    };
    const client = new OpenAiCompatibleClient(config, { apiKey: "k", fetch: fetch as typeof globalThis.fetch });
    const controller = new AbortController();
    const pending = client.streamChat(turns, { signal: controller.signal, onDelta: () => {} });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});

describe("parseJsonResponse", () => {
  it("兼容代码围栏和前后解释文本", () => {
    expect(parseJsonResponse<{ a: number }>("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseJsonResponse<{ a: number }>("结果如下： {\"a\":2} 完成")).toEqual({ a: 2 });
  });
});
