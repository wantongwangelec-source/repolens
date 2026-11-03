import type {
  BoundaryDto,
  ChangeReportDto,
  CommitDto,
  ChatContextItemDto,
  ChatDoneDto,
  ChatRequestDto,
  ChatToolStepDto,
  ConfirmedLayer,
  FileDetailDto,
  FindingDto,
  FindingKind,
  FindingSummaryDto,
  GraphDto,
  LensKind,
  LensValueDto,
  ModuleCardDto,
  NoteDto,
  NoteInputDto,
  OverviewDto,
  PickRepoResultDto,
  ReadmeDto,
  RepoScanTaskDto,
  ReposDto,
  SearchHitDto,
  SemanticResultDto,
  SkeletonDto,
  SourceSliceDto,
  SpecDto,
  SymbolDetailDto,
  TreeNodeDto,
  TypeFlowDto,
  EntryPointDto,
  WalkFrameDto,
} from "@repolens/core/types";
import { t, translateMessage } from "../i18n";

const BASE = "/api";

/**
 * The repository currently being viewed.
 *
 * Put it in the module scope rather than passing it through every call site, for the same reason as BASE: it is 'where to send the request'
 * Part of it, not a parameter of a particular query. Add a repoId parameter to more than twenty call sites,
 * It would only make each level have to remember to pass it down, and if one place is missed, it quietly ends up in another repository.
 *
 * When left undefined, the server falls back to the repository at startup, so the first screen does not need to fetch the manifest once beforehand.
 * Only then did I dare to make the first request.
 */
let activeRepo: string | undefined = repoFromLocation();

/** The repository specified by the current URL. The Store uses it when first started to restore the selections from before the refresh. */
export function getActiveRepo(): string | undefined {
  return activeRepo;
}

export function setActiveRepo(id: string | undefined): void {
  activeRepo = id;
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id === undefined || id === "") url.searchParams.delete("repo");
  else url.searchParams.set("repo", id);
  window.history.replaceState(window.history.state, "", url);
}

function repoFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = new URL(window.location.href).searchParams.get("repo")?.trim();
  return value ? value : undefined;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function get<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  repo: string | undefined = activeRepo,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  if (repo !== undefined) search.set("repo", repo);
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query.length > 0 ? `?${query}` : ""}`);

  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function post<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  intent = "generate-semantic",
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  if (activeRepo !== undefined) search.set("repo", activeRepo);
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query.length > 0 ? `?${query}` : ""}`, {
    method: "POST",
    headers: { "x-repolens-intent": intent },
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function send<T>(
  method: "POST" | "DELETE",
  path: string,
  intent: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<T> {
  const search = new URLSearchParams(params);
  if (activeRepo !== undefined) search.set("repo", activeRepo);
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query.length > 0 ? `?${query}` : ""}`, {
    method,
    headers: {
      "x-repolens-intent": intent,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function toError(response: Response): Promise<ApiError> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) detail = body.error;
  } catch {
    // If the response body is not JSON, use the status text
  }
  return new ApiError(translateMessage(detail), response.status);
}

export interface GraphParams {
  scope?: string;
  limit?: number;
  roles?: string;
  external?: boolean;
  /** Node id that must appear in the results and is not allowed to be collapsed */
  keep?: string;
}

export interface CallGraphParams {
  depth?: number;
  direction?: "callers" | "callees" | "both";
  limit?: number;
  /** Comma-separated confidence levels */
  confidence?: string;
}

export interface FindingsResponse {
  summary: FindingSummaryDto;
  items: FindingDto[];
}

/** Keep an eye on the status of file changes, consistent with the server-side WatchManager */
export interface WatchStatusDto {
  enabled: boolean;
  refreshing: boolean;
  refreshedAt: string | null;
  error: string | null;
}

export interface RepoEventHandlers {
  onStatus: (status: WatchStatusDto) => void;
  /** The index has been refreshed according to the latest files. */
  onIndex: (refreshedAt: string) => void;
}

export const api = {
  repos: () => get<ReposDto>("/repos"),

  pickAndScanRepo: () =>
    post<PickRepoResultDto>("/repos/pick-and-scan", {}, "scan-repository"),

  repoScans: () => get<{ tasks: RepoScanTaskDto[] }>("/repo-scans"),

  repoScan: (id: string) => get<RepoScanTaskDto>(`/repo-scans/${encodeURIComponent(id)}`),

  rescanRepo: (id: string) =>
    post<RepoScanTaskDto>(`/repos/${encodeURIComponent(id)}/scan`, {}, "scan-repository"),

  forgetRepo: async (id: string): Promise<void> => {
    const response = await fetch(`${BASE}/repos/${id}`, { method: "DELETE" });
    if (!response.ok) throw await toError(response);
  },

  findings: (kind?: FindingKind, scope?: string) =>
    get<FindingsResponse>("/findings", { kind, scope }),

  revealChain: (nodeId: string) =>
    get<{ chain: string[] }>(`/reveal/${nodeId}`),

  overview: () => get<OverviewDto>("/overview"),

  /** Read the overview of any repository in the repository list without switching the current repository or modifying the URL. */
  repoOverview: (id: string) => get<OverviewDto>("/overview", {}, id),

  tree: (path: string, depth = 1, roles?: string) =>
    get<TreeNodeDto>("/tree", { path, depth, roles }),

  /** One level of the structure tree: all entries on the disk, each with a status indicating whether it participates in the analysis */
  files: (path: string) => get<TreeNodeDto>("/files", { path }),

  graph: (params: GraphParams) =>
    get<GraphDto>("/graph", {
      scope: params.scope,
      limit: params.limit,
      roles: params.roles,
      external: params.external ? 1 : undefined,
      keep: params.keep,
    }),

  callGraph: (symbolId: number, params: CallGraphParams = {}) =>
    get<GraphDto>(`/callgraph/${symbolId}`, {
      depth: params.depth,
      direction: params.direction,
      limit: params.limit,
      confidence: params.confidence,
    }),

  entries: () => get<EntryPointDto[]>("/entries"),

  /** The first time comparing a commit, exporting a snapshot and building a baseline index may take a few seconds. */
  changes: (base: string) => post<ChangeReportDto>("/changes", { base }, "compare-changes"),

  /** Recently committed scanned roots, with the newest first; empty if not in git */
  commits: () => get<CommitDto[]>("/commits"),

  walk: (symbolId: string) => get<WalkFrameDto>(`/walk/${stripPrefix(symbolId)}`),

  file: (id: string) => get<FileDetailDto>(`/file/${stripPrefix(id)}`),

  symbol: (id: string) => get<SymbolDetailDto>(`/symbol/${stripPrefix(id)}`),

  generateSymbolSemantics: (id: string, refresh = false) =>
    post<SemanticResultDto>(`/semantic/symbol/${stripPrefix(id)}`, {
      refresh: refresh ? 1 : undefined,
    }),

  generateFileSummary: (id: string, refresh = false) =>
    post<SemanticResultDto>(`/semantic/file/${stripPrefix(id)}`, {
      refresh: refresh ? 1 : undefined,
    }),

  source: (fileId: string, from?: number, to?: number) =>
    get<SourceSliceDto>(`/source/${stripPrefix(fileId)}`, { from, to }),

  /** Files not added to the index are read in their original form according to the repository relative path */
  rawSource: (path: string) => get<SourceSliceDto>("/raw", { path }),

  /** The README at the package/directory level is null when it does not exist */
  readme: (nodeId: string) => get<ReadmeDto | null>("/readme", { node: nodeId }),

  search: (q: string, limit = 30, roles?: string) =>
    get<SearchHitDto[]>("/search", { q, limit, roles }),

  notes: () => get<{ notes: NoteDto[] }>("/notes"),

  addNote: (input: NoteInputDto) => send<NoteDto>("POST", "/notes", "save-note", input),

  deleteNote: (id: string) => send<{ ok: true }>("DELETE", `/notes/${encodeURIComponent(id)}`, "save-note"),

  /** What constitutes an edge in the architecture diagram; when there is no direct dependency, the shortest import chain */
  boundary: (from: string, to: string, roles?: string) => get<BoundaryDto>("/boundary", { from, to, roles }),

  moduleCard: (nodeId: string) => get<ModuleCardDto>("/module", { node: nodeId }),

  spec: (nodeId: string) => get<SpecDto>("/spec", { node: nodeId }),

  typeFlow: (id: string) => get<TypeFlowDto>(`/typeflow/${stripPrefix(id)}`),

  skeleton: () => get<SkeletonDto>("/skeleton"),

  lens: (kind: LensKind, ids: string[]) => get<Record<string, LensValueDto>>("/lens", { kind, ids: ids.join(",") }),

  confirmLayers: (layers: ConfirmedLayer[]) =>
    send<{ layers: ConfirmedLayer[] }>("POST", "/layers/confirm", "confirm-layers", { layers }),

  /** Record the current inter-module dependencies as an approved list (.repolens.lock.json) */
  writeLock: () => send<{ level: "package" | "directory"; dependencies: number }>("POST", "/lock", "write-lock"),

  /** Incremental scans that only refresh the structure without invoking the model will only return after completion; consistent between refreshedAt and the simultaneously emitted index event. */
  refreshIndex: (repoId: string) =>
    send<{ ok: true; refreshedAt: string }>("POST", `/repos/${encodeURIComponent(repoId)}/refresh`, "scan-repository"),

  watchStatus: (repoId: string) => get<WatchStatusDto>(`/repos/${encodeURIComponent(repoId)}/watch`),

  setWatch: (repoId: string, enabled: boolean) =>
    send<WatchStatusDto>("POST", `/repos/${encodeURIComponent(repoId)}/watch`, "watch-repository", { enabled }),

  chat: streamChat,
};

/**
 * Subscribe to real-time events of a repository: watch for state changes and index refresh completion. EventSource will automatically reconnect if disconnected.
 * After reconnecting, the server first pushes the current status, so the interface won't stay on an expired state. Returns a function to unsubscribe.
 */
export function subscribeRepoEvents(repoId: string, handlers: RepoEventHandlers): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`${BASE}/repos/${encodeURIComponent(repoId)}/events`);
  source.addEventListener("status", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { status?: WatchStatusDto };
    if (payload.status) handlers.onStatus(payload.status);
  });
  source.addEventListener("index", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { refreshedAt?: string };
    handlers.onIndex(payload.refreshedAt ?? new Date().toISOString());
  });
  return () => source.close();
}

export interface ChatStreamHandlers {
  onContext?: (items: ChatContextItemDto[]) => void;
  onDelta: (text: string) => void;
  onTool?: (step: ChatToolStepDto) => void;
}

/**
 * Follow-up question to AI. EventSource can only send GET, but the question and context references need to be placed in the request body,
 * So use fetch to read the stream and manually split SSE events.
 */
async function streamChat(
  request: ChatRequestDto,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<ChatDoneDto> {
  const query = activeRepo !== undefined ? `?repo=${encodeURIComponent(activeRepo)}` : "";
  const response = await fetch(`${BASE}/chat${query}`, {
    method: "POST",
    headers: { "x-repolens-intent": "chat", "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw await toError(response);
  if (!response.body) throw new ApiError(t("浏览器不支持流式响应"), 0);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const result: { done: ChatDoneDto | null } = { done: null };

  const dispatch = () => {
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
    if (event === "delta" && typeof payload["text"] === "string") handlers.onDelta(payload["text"]);
    else if (event === "tool" && typeof payload["id"] === "string") handlers.onTool?.(payload as unknown as ChatToolStepDto);
    else if (event === "context" && Array.isArray(payload["items"])) {
      handlers.onContext?.(payload["items"] as ChatContextItemDto[]);
    } else if (event === "done") result.done = payload as unknown as ChatDoneDto;
    else if (event === "error") throw new ApiError(payload["message"] ? translateMessage(String(payload["message"])) : t("AI 回答失败"), 502);
  };

  while (true) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        dispatch();
        event = "message";
        data = [];
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  dispatch();
  if (result.done === null) throw new ApiError(t("回答在中途断开了"), 0);
  return result.done;
}

function stripPrefix(id: string): string {
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
}
