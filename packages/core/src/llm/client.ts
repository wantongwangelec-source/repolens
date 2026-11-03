import type { LlmConfig, LlmUsage } from "../types.js";

export class LlmUnavailableError extends Error {
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "LlmResponseError";
  }
}

export interface CompletionResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface CompletionOptions {
  maxOutputTokens?: number | undefined;
}

export type ChatTurn =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** A single function call that the model is required to execute; arguments are JSON text written by the model and are not guaranteed to be valid */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamOptions extends CompletionOptions {
  signal?: AbortSignal | undefined;
  onDelta: (text: string) => void;
  tools?: ToolDefinition[] | undefined;
  /** none: Defined with tools but not allowed to call them anymore, used in the final round to force the model to answer directly */
  toolChoice?: "auto" | "none" | undefined;
}

export interface StreamResult {
  content: string;
  usage: LlmUsage;
  toolCalls: ToolCall[];
  /** The service doesn't recognize the 'tools' parameter; this time it was resent after removing the tool. */
  toolsRejected: boolean;
}

export interface LlmClientOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string | undefined;
}

/**
 * The smallest OpenAI Chat Completions client.
 *
 * Not relying on vendor SDKs: As long as Ollama, vLLM, and various custom gateways are implemented
 * `/chat/completions` can be used directly, and it also avoids bringing the Node-specific SDK into the web dependency graph.
 */
export class OpenAiCompatibleClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiKey: string;
  private readonly slots: Semaphore;

  constructor(
    readonly config: LlmConfig,
    options: LlmClientOptions = {},
  ) {
    const reason = llmUnavailableReason(config, options.apiKey);
    if (reason !== null) throw new LlmUnavailableError(reason);

    this.apiKey = options.apiKey ?? envApiKey(config) ?? "";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    const semaphoreKey = `${config.baseUrl}\0${config.model}\0${config.maxConcurrency}`;
    this.slots = sharedSemaphores.get(semaphoreKey) ?? new Semaphore(config.maxConcurrency);
    sharedSemaphores.set(semaphoreKey, this.slots);
  }

  async completeJson<T>(
    system: string,
    user: string,
    options: CompletionOptions = {},
  ): Promise<CompletionResult<T>> {
    const release = await this.slots.acquire();
    try {
      const body = await this.requestWithRetry(system, user, options);
      const content = completionContent(body);
      return {
        data: parseJsonResponse<T>(content),
        usage: responseUsage(body),
      };
    } finally {
      release();
    }
  }

  /**
   * Streamed conversation, used for interactive follow-up questions.
   *
   * Does not occupy concurrent slots for background batch tasks: users should not have to wait behind hundreds of summary requests while waiting for a response.
   * Retry only before receiving the first byte — the content already sent to the interface cannot be withdrawn, and the stream may be interrupted midway
   * Directly report an error, and let the user decide whether to retry.
   */
  async streamChat(messages: ChatTurn[], options: StreamOptions): Promise<StreamResult> {
    const { response, controller, idle, toolsRejected } = await this.openStream(messages, options);
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream") || response.body === null) {
        // Some gateways ignore the stream parameter and still return the complete JSON at once
        const text = await response.text();
        const body = parseJsonObject(text, response.status);
        const toolCalls = messageToolCalls(body);
        const content = toolCalls.length > 0 ? optionalContent(body) : completionContent(body);
        if (content !== "") options.onDelta(content);
        return { content, usage: responseUsage(body), toolCalls, toolsRejected };
      }
      return { ...(await readEventStream(response.body, options.onDelta, idle)), toolsRejected };
    } catch (err) {
      throw normalizeError(err, this.config.requestTimeoutMs, options.signal);
    } finally {
      idle.stop();
      controller.abort();
    }
  }

  private async openStream(
    messages: ChatTurn[],
    options: StreamOptions,
  ): Promise<{ response: Response; controller: AbortController; idle: IdleTimer; toolsRejected: boolean }> {
    let lastError: Error | null = null;
    let includeUsage = true;
    let tools = options.tools !== undefined && options.tools.length > 0 ? options.tools : null;
    const offeredTools = tools !== null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (options.signal?.aborted) throw abortError();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      const idle = new IdleTimer(this.config.requestTimeoutMs, () => controller.abort());
      try {
        const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...this.headers(), accept: "text/event-stream" },
          signal: controller.signal,
          body: JSON.stringify({
            ...this.requestBody(messages, options),
            ...(tools === null ? {} : { tools, tool_choice: options.toolChoice ?? "auto" }),
            stream: true,
            ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          }),
        });
        if (response.ok) return { response, controller, idle, toolsRejected: offeredTools && tools === null };

        const text = await response.text();
        const error = new LlmResponseError(safeApiError(text) ?? `LLM HTTP ${response.status}`, response.status);
        const badRequest = response.status === 400 || response.status === 422;
        if (includeUsage && badRequest && /stream_options/i.test(text)) {
          // Older compatible gateways do not recognize stream_options; resend once after removing it, retries are not counted.
          includeUsage = false;
          attempt--;
          idle.stop();
          continue;
        }
        if (tools !== null && badRequest && /tool|function/i.test(text)) {
          // The model or gateway does not support function calls (many local models are like this), and falls back to using only pre-assembled context.
          tools = null;
          attempt--;
          idle.stop();
          continue;
        }
        if (!retryableStatus(response.status) || attempt === this.config.maxRetries) throw error;
        lastError = error;
      } catch (err) {
        const error = normalizeError(err, this.config.requestTimeoutMs, options.signal);
        if (options.signal?.aborted || !retryableError(error) || attempt === this.config.maxRetries) {
          idle.stop();
          throw error;
        }
        lastError = error;
      } finally {
        options.signal?.removeEventListener("abort", forwardAbort);
      }
      idle.stop();
      await sleep(Math.min(2_000, 200 * 2 ** attempt));
    }

    throw lastError ?? new LlmResponseError("LLM 请求失败", null);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== "") headers["authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  private requestBody(messages: ChatTurn[], options: CompletionOptions): Record<string, unknown> {
    return {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      ...(this.config.reasoningEffort === null ? {} : { reasoning_effort: this.config.reasoningEffort }),
      max_tokens: Math.min(
        this.config.maxOutputTokens,
        Math.max(64, options.maxOutputTokens ?? this.config.maxOutputTokens),
      ),
    };
  }

  private async requestWithRetry(
    system: string,
    user: string,
    options: CompletionOptions,
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          signal: controller.signal,
          body: JSON.stringify(
            this.requestBody(
              [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              options,
            ),
          ),
        });

        const text = await response.text();
        if (!response.ok) {
          const message = safeApiError(text) ?? `LLM HTTP ${response.status}`;
          const error = new LlmResponseError(message, response.status);
          if (!retryableStatus(response.status) || attempt === this.config.maxRetries) throw error;
          lastError = error;
        } else {
          const parsed = JSON.parse(text) as unknown;
          if (typeof parsed !== "object" || parsed === null) {
            throw new LlmResponseError("LLM 返回的响应不是 JSON 对象", response.status);
          }
          return parsed as Record<string, unknown>;
        }
      } catch (err) {
        const error = normalizeError(err, this.config.requestTimeoutMs);
        if (!retryableError(error) || attempt === this.config.maxRetries) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }

      await sleep(Math.min(2_000, 200 * 2 ** attempt));
    }

    throw lastError ?? new LlmResponseError("LLM 请求失败", null);
  }
}

function completionContent(body: Record<string, unknown>): string {
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmResponseError("LLM 响应缺少 choices", 200);
  }
  const choice = choices[0];
  const message = typeof choice === "object" && choice !== null ? choice["message"] : null;
  const content =
    typeof message === "object" && message !== null ? message["content"] : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof part["text"] === "string"
          ? part["text"]
          : "",
      )
      .join("");
  }
  throw new LlmResponseError("LLM 响应缺少文本 content", 200);
}

/** When only calling the tool, content is often null */
function optionalContent(body: Record<string, unknown>): string {
  try {
    return completionContent(body);
  } catch {
    return "";
  }
}

function messageToolCalls(body: Record<string, unknown>): ToolCall[] {
  const choices = body["choices"];
  const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | null) : null;
  const message = typeof choice === "object" && choice !== null ? choice["message"] : null;
  const raw = typeof message === "object" && message !== null ? (message as Record<string, unknown>)["tool_calls"] : null;
  if (!Array.isArray(raw)) return [];
  const calls = new ToolCallCollector();
  raw.forEach((item, index) => calls.add(item, index));
  return calls.finish();
}

/**
 * In a streaming response, a single function call is split into many pieces: the first piece contains the id and function name, and the following pieces only continue with the arguments.
 * Rely on the index to match which call it is. A few gateways don't provide the index, so default to the order of appearance.
 */
class ToolCallCollector {
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();

  add(raw: unknown, fallbackIndex: number): void {
    if (typeof raw !== "object" || raw === null) return;
    const part = raw as Record<string, unknown>;
    const index = typeof part["index"] === "number" ? part["index"] : fallbackIndex;
    const call = this.calls.get(index) ?? { id: "", name: "", args: "" };
    if (typeof part["id"] === "string" && part["id"] !== "") call.id = part["id"];
    const fn = typeof part["function"] === "object" && part["function"] !== null
      ? part["function"] as Record<string, unknown>
      : {};
    // The function name only appears on the first page; for individual gateways, it is repeated on every page and cannot be concatenated.
    if (typeof fn["name"] === "string" && call.name === "") call.name = fn["name"];
    if (typeof fn["arguments"] === "string") call.args += fn["arguments"];
    else if (typeof fn["arguments"] === "object" && fn["arguments"] !== null) call.args = JSON.stringify(fn["arguments"]);
    this.calls.set(index, call);
  }

  finish(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name !== "")
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.args },
      }));
  }
}

export function parseJsonResponse<T>(content: string): T {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced) as T;
  } catch {
    // Some compatible gateways ignore 'return JSON only' and add explanations before and after, using the outermost object as a fallback.
    const start = Math.min(...[unfenced.indexOf("{"), unfenced.indexOf("[")].filter((i) => i >= 0));
    const objectEnd = unfenced.lastIndexOf("}");
    const arrayEnd = unfenced.lastIndexOf("]");
    const end = Math.max(objectEnd, arrayEnd);
    if (Number.isFinite(start) && start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1)) as T;
      } catch {
        // Hand over to the following unified error
      }
    }
    throw new LlmResponseError("LLM 没有返回可解析的 JSON", 200);
  }
}

function responseUsage(body: Record<string, unknown>): LlmUsage {
  const usage = body["usage"];
  const value = typeof usage === "object" && usage !== null ? usage : {};
  const input = numberField(value, "prompt_tokens") || numberField(value, "input_tokens");
  const output =
    numberField(value, "completion_tokens") || numberField(value, "output_tokens");
  const total = numberField(value, "total_tokens") || input + output;
  return { requests: 1, inputTokens: input, outputTokens: output, totalTokens: total };
}

function numberField(value: object, key: string): number {
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "number" && Number.isFinite(found) ? found : 0;
}

function safeApiError(text: string): string | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body["error"];
    if (typeof error === "string") return error.slice(0, 500);
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return message.slice(0, 500);
    }
  } catch {
    // Non-JSON error pages should only retain short text, and under no circumstances should the response headers (which may contain credentials) be included in the exception.
  }
  const compact = text.trim().replace(/\s+/g, " ");
  return compact === "" ? null : compact.slice(0, 500);
}

function normalizeError(error: unknown, timeoutMs: number, signal?: AbortSignal): Error {
  if (signal?.aborted) return abortError();
  if (error instanceof LlmResponseError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmResponseError(`LLM 请求超过 ${timeoutMs}ms`, null);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}

function parseJsonObject(text: string, status: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmResponseError("LLM 返回的响应不是 JSON", status);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LlmResponseError("LLM 返回的响应不是 JSON 对象", status);
  }
  return parsed as Record<string, unknown>;
}

/** Abort if no data is received for more than timeoutMs; streaming responses are not considered timed out as long as they are still outputting text. */
class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
  ) {
    this.touch();
  }

  touch(): void {
    this.stop();
    this.timer = setTimeout(this.onIdle, this.timeoutMs);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  idle: IdleTimer,
): Promise<Omit<StreamResult, "toolsRejected">> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: LlmUsage = { ...emptyUsage(), requests: 1 };
  const calls = new ToolCallCollector();

  const handle = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return true;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return false;
    }
    if (typeof chunk !== "object" || chunk === null) return false;
    const record = chunk as Record<string, unknown>;
    if (record["error"] !== undefined) {
      throw new LlmResponseError(safeApiError(JSON.stringify(record)) ?? "LLM 流式响应报错", 200);
    }
    const delta = deltaText(record);
    if (delta !== "") {
      content += delta;
      onDelta(delta);
    }
    deltaToolCalls(record).forEach((part, index) => calls.add(part, index));
    if (typeof record["usage"] === "object" && record["usage"] !== null) usage = responseUsage(record);
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      idle.touch();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (handle(line)) return { content, usage, toolCalls: calls.finish() };
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") handle(buffer.trim());
    return { content, usage, toolCalls: calls.finish() };
  } finally {
    reader.releaseLock();
  }
}

function deltaText(chunk: Record<string, unknown>): string {
  const choices = chunk["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as Record<string, unknown> | null;
  const delta = typeof choice === "object" && choice !== null ? choice["delta"] : null;
  const content = typeof delta === "object" && delta !== null ? (delta as Record<string, unknown>)["content"] : null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof part["text"] === "string" ? part["text"] : "",
      )
      .join("");
  }
  return "";
}

function deltaToolCalls(chunk: Record<string, unknown>): unknown[] {
  const choices = chunk["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const choice = choices[0] as Record<string, unknown> | null;
  const delta = typeof choice === "object" && choice !== null ? choice["delta"] : null;
  const calls = typeof delta === "object" && delta !== null ? (delta as Record<string, unknown>)["tool_calls"] : null;
  return Array.isArray(calls) ? calls : [];
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryableError(error: Error): boolean {
  return !(error instanceof LlmResponseError) || error.status === null || retryableStatus(error.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

const sharedSemaphores = new Map<string, Semaphore>();

/**
 * Determine whether AI can be used based on the current configuration, and return the reason if it cannot be used.
 *
 * Only look at the switches and credentials without sending requests: the overview interface is called every time the page is opened, probing the network
 * It is both slow and may incur costs.
 */
export function llmUnavailableReason(config: LlmConfig, explicitKey?: string): string | null {
  if (!config.enabled) return "LLM 已在配置中关闭";
  const apiKey = explicitKey ?? envApiKey(config);
  if (apiKey === undefined || (apiKey === "" && config.apiKeyEnv.trim() !== "")) {
    return `未设置环境变量 ${config.apiKeyEnv}`;
  }
  return null;
}

function envApiKey(config: LlmConfig): string | undefined {
  return config.apiKeyEnv.trim() === "" ? "" : process.env[config.apiKeyEnv]?.trim();
}

export function emptyUsage(): LlmUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsage(target: LlmUsage, value: LlmUsage): void {
  target.requests += value.requests;
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.totalTokens += value.totalTokens;
}
