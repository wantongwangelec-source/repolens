import {
  BaselineError,
  FINDING_KINDS,
  buildChangeReport,
  buildLock,
  confirmedLayers,
  currentLlmStatus,
  getBoundary,
  getCallGraph,
  getEntryPoints,
  getFileDetail,
  getFileTree,
  getFindingSummary,
  getLens,
  getModuleCard,
  getRevealChain,
  getFindings,
  getOverview,
  getScopeGraph,
  getScopeReadme,
  getSkeleton,
  getSource,
  getSpec,
  getSymbolDetail,
  getTree,
  getTypeFlow,
  getWalkFrame,
  generateFileSummary,
  generateSymbolSemantics,
  NoteInputError,
  addNote,
  deleteNote,
  indexPath,
  listCommits,
  listNotes,
  loadConfig,
  openDb,
  parseChatRequest,
  parseNoteInput,
  readRepoFile,
  recordChatUsage,
  refreshConventions,
  RepoFileError,
  search,
  streamRepositoryChat,
  updateRepoConfig,
  writeLock,
  type Confidence,
  type ConfirmedLayer,
  type Db,
  type FileRole,
  type LensKind,
} from "@repolens/core";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";

export interface ApiDeps {
  db: Db;
  repoRoot: string;
}

/**
 * HTTP API. Except for semantic/chat/notes write requests with local intent tags, all others are read-only.
 *
 * All endpoints are in the form of 'pulling a layer on demand', with no endpoints that return the entire graph——
 * This is the hard constraint of the 'transfer' strategy in docs/INTERACTION.md: the frontend does not hold the entire map.
 */
export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();
  const { db } = deps;
  // Use the actual directory where the index is located as the standard, not the repo_root recorded in the index: the repository along with .repolens
  // After being moved or copied together, that path points to the old location, and reading the source code, writing cache, and notes will all go to the wrong place.
  const { repoRoot } = deps;

  app.get("/overview", (c) => {
    const overview = getOverview(db);
    return c.json({ ...overview, llm: currentLlmStatus(db, repoRoot) ?? overview.llm });
  });

  app.get("/tree", (c) => {
    const path = c.req.query("path") ?? ".";
    const depth = clampInt(c.req.query("depth"), 1, 0, 4);
    const roles = parseRoles(c.req.query("roles"));
    return c.json(getTree(db, path, depth, roles));
  });

  // The structure tree lists all files by disk separately from the /tree that only looks at the index: here it is necessary to read the directory and determine the exclusion reason according to the configuration.
  app.get("/files", (c) =>
    repoFile(c, () => getFileTree(db, repoRoot, loadConfig(repoRoot), c.req.query("path") ?? ".")),
  );

  app.get("/raw", (c) => repoFile(c, () => readRepoFile(repoRoot, c.req.query("path") ?? "")));

  app.get("/graph", (c) => {
    const graph = getScopeGraph(db, {
      scope: c.req.query("scope") ?? undefined,
      limit: clampInt(c.req.query("limit"), 30, 3, 400),
      roles: parseRoles(c.req.query("roles")),
      confidence: parseConfidence(c.req.query("confidence")),
      includeExternal: parseBool(c.req.query("external")),
      keep: c.req.query("keep") ?? undefined,
    });
    return c.json(graph);
  });

  // Call graph and /graph are separate: /graph is 'what is in this scope', drilling down by hierarchy;
  // Here is 'which people this function interacts with,' spreading according to the number of hops. The pagination semantics of the two are completely different.
  // Forcing it into an endpoint will only make the meaning of 'limit' ambiguous.
  app.get("/findings", (c) => {
    const kind = c.req.query("kind");
    const scope = c.req.query("scope");
    return c.json({
      summary: getFindingSummary(db, scope),
      items: getFindings(db, {
        kind: FINDING_KINDS.find((known) => known === kind),
        scope,
        limit: clampInt(c.req.query("limit"), 200, 1, 1000),
      }),
    });
  });

  app.get("/reveal/:nodeId{.+}", (c) =>
    c.json({ chain: getRevealChain(db, c.req.param("nodeId")) }),
  );

  app.get("/callgraph/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    return c.json(
      getCallGraph(db, {
        symbolId: id,
        depth: clampInt(c.req.query("depth"), 1, 1, 4),
        direction: parseDirection(c.req.query("direction")),
        limit: clampInt(c.req.query("limit"), 12, 1, 200),
        confidence: parseConfidence(c.req.query("confidence")),
      }),
    );
  });

  app.get("/entries", (c) => c.json(getEntryPoints(db)));

  // Single-step execution reads only one frame at a time: when stepping in, the frontend takes the next frame according to the landing point ID, and the call stack is held by the frontend
  app.get("/walk/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    const frame = getWalkFrame(db, id);
    return frame ? c.json(frame) : c.json({ error: "符号不存在" }, 404);
  });

  app.get("/file/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    const detail = getFileDetail(db, id, repoRoot);
    return detail ? c.json(detail) : c.json({ error: "文件不存在" }, 404);
  });

  app.get("/symbol/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    const detail = getSymbolDetail(db, id, repoRoot);
    return detail ? c.json(detail) : c.json({ error: "符号不存在" }, 404);
  });

  // What a line on the architecture diagram consists of: imports across boundaries, symbols that are used, upstream routing; provide the shortest chain when there are no direct dependencies
  app.get("/boundary", (c) => {
    const boundary = getBoundary(db, c.req.query("from") ?? "", c.req.query("to") ?? "", parseRoles(c.req.query("roles")));
    return boundary ? c.json(boundary) : c.json({ error: "认不出这两个节点" }, 404);
  });

  app.get("/module", (c) => {
    const card = getModuleCard(db, c.req.query("node") ?? "");
    return card ? c.json(card) : c.json({ error: "只有包和目录有模块名片" }, 404);
  });

  app.get("/spec", (c) => {
    const spec = getSpec(db, c.req.query("node") ?? "");
    return spec ? c.json(spec) : c.json({ error: "节点不存在" }, 404);
  });

  app.get("/typeflow/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    const flow = getTypeFlow(db, id);
    return flow ? c.json(flow) : c.json({ error: "不是类型" }, 404);
  });

  app.get("/skeleton", (c) => c.json(getSkeleton(db)));

  app.get("/lens", (c) => {
    const kind = c.req.query("kind");
    if (kind !== "heat" && kind !== "tests") return c.json({ error: "未知的视角" }, 400);
    const ids = (c.req.query("ids") ?? "").split(",").filter((id) => /^(?:dir|pkg|file|sym):./.test(id));
    return c.json(getLens(db, kind as LensKind, ids));
  });

  // The layering proposed by AI is written into the agreement after human confirmation, and subsequent reverse checks of the layering only recognize this version.
  app.post("/layers/confirm", async (c) => {
    if (c.req.header("x-repolens-intent") !== "confirm-layers") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const body = await jsonBody(c);
    const layers = parseLayers(body?.["layers"]);
    if (layers === null) return c.json({ error: "分层格式不正确：每层要有名字和至少一个 pkg: / dir: 成员" }, 400);
    updateRepoConfig(repoRoot, { layers });
    await withWritableDb(repoRoot, async (writeDb) => refreshConventions(writeDb, { layers }));
    return c.json({ layers: confirmedLayers(db) });
  });

  // Record the current inter-module dependencies as a dependency lock: any new dependencies that arise in the future must first be approved
  app.post("/lock", async (c) => {
    if (c.req.header("x-repolens-intent") !== "write-lock") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const lock = buildLock(db);
    writeLock(repoRoot, lock);
    await withWritableDb(repoRoot, async (writeDb) => refreshConventions(writeDb, { lock }));
    return c.json({ level: lock.level, dependencies: lock.dependencies.length });
  });

  // Semantic generation is the only writing interface, but the target can only be the numeric ID that already exists in the current index; paths cannot be passed.
  // Write connections are briefly opened on request, read connections remain readonly, and the security boundary is not expanded.
  app.post("/semantic/symbol/:id", async (c) => {
    if (c.req.header("x-repolens-intent") !== "generate-semantic") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    if (getSymbolDetail(db, id) === null) return c.json({ error: "符号不存在" }, 404);
    return withWritableDb(repoRoot, async (writeDb) => {
      try {
        return c.json(await generateSymbolSemantics(writeDb, repoRoot, id, {
          force: parseBool(c.req.query("refresh")),
        }));
      } catch (err) {
        const message = (err as Error).message;
        const status = /未设置环境变量|LLM 已.*关闭/.test(message) ? 503 : 502;
        return c.json({ error: message }, status);
      }
    });
  });

  app.post("/semantic/file/:id", async (c) => {
    if (c.req.header("x-repolens-intent") !== "generate-semantic") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    if (getFileDetail(db, id) === null) return c.json({ error: "文件不存在" }, 404);
    return withWritableDb(repoRoot, async (writeDb) => {
      try {
        return c.json(await generateFileSummary(writeDb, repoRoot, id, {
          force: parseBool(c.req.query("refresh")),
        }));
      } catch (err) {
        const message = (err as Error).message;
        const status = /未设置环境变量|LLM 已.*关闭/.test(message) ? 503 : 502;
        return c.json({ error: message }, status);
      }
    });
  });

  // Follow-up questioning AI. The request only contains the question text and node id, the source code is read by the server according to the id; answer
  // Returning via SSE stream, the events occur in order as context (the context actually put into the prompt) and interspersed appearances
  // delta and tool (every step the model checks by itself), finally done or error. Use read-only to read the context
  // The connection, writing the connection is only briefly opened during accounting.
  app.post("/chat", async (c) => {
    if (c.req.header("x-repolens-intent") !== "chat") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是 JSON" }, 400);
    }
    const request = parseChatRequest(body);
    if (request === null) return c.json({ error: "对话格式不正确，最后一条必须是用户消息" }, 400);

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      // Deltas are written serially in the order of arrival to avoid concurrent writes from disturbing the order.
      let writes = Promise.resolve();
      const send = (event: string, data: unknown) => {
        writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
        return writes;
      };
      try {
        const done = await streamRepositoryChat(db, repoRoot, request, {
          signal: controller.signal,
          onContext: (items) => void send("context", { items }),
          onDelta: (text) => void send("delta", { text }),
          onTool: (step) => void send("tool", step),
        });
        await send("done", done);
        await withWritableDb(repoRoot, async (writeDb) => recordChatUsage(writeDb, repoRoot, done.usage));
      } catch (err) {
        if (controller.signal.aborted) return;
        await send("error", { message: (err as Error).message.slice(0, 500) });
      }
    });
  });

  // The notes are written in notes.json next to the index, bypassing index.db, so a read-only connection is sufficient:
  // It is only responsible for converting the node id into a path and line number.
  app.get("/notes", (c) => {
    try {
      return c.json({ notes: listNotes(db, repoRoot) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/notes", async (c) => {
    if (c.req.header("x-repolens-intent") !== "save-note") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是 JSON" }, 400);
    }
    const input = parseNoteInput(body);
    if (input === null) return c.json({ error: "笔记格式不正确" }, 400);
    try {
      return c.json(addNote(db, repoRoot, input));
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof NoteInputError ? 400 : 500);
    }
  });

  app.delete("/notes/:id", (c) => {
    if (c.req.header("x-repolens-intent") !== "save-note") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    try {
      return deleteNote(repoRoot, c.req.param("id"))
        ? c.json({ ok: true })
        : c.json({ error: "笔记不存在" }, 404);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // To compare changes, you need to export the baseline snapshot and write to .repolens/baselines, marking local intentions according to the write operation requirements.
  // The comparison is with the current index (the code from the last scan), and it is not rescanned here incidentally.
  app.post("/changes", async (c) => {
    if (c.req.header("x-repolens-intent") !== "compare-changes") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    try {
      return c.json(await buildChangeReport(repoRoot, { base: c.req.query("base")?.trim() || "HEAD" }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof BaselineError ? 400 : 500);
    }
  });

  app.get("/commits", (c) => c.json(listCommits(repoRoot, clampInt(c.req.query("limit"), 60, 1, 300))));

  app.get("/source/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    const from = optionalInt(c.req.query("from"));
    const to = optionalInt(c.req.query("to"));
    const slice = getSource(db, repoRoot, id, from, to);
    return slice ? c.json(slice) : c.json({ error: "源码不可读" }, 404);
  });

  // Having no README is normal, return null instead of 404
  app.get("/readme", (c) => c.json(getScopeReadme(db, repoRoot, c.req.query("node") ?? "")));

  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json(
      search(db, q, clampInt(c.req.query("limit"), 30, 1, 100), parseRoles(c.req.query("roles"))),
    );
  });

  return app;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseLayers(raw: unknown): ConfirmedLayer[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const layers: ConfirmedLayer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const layer = item as Record<string, unknown>;
    const name = typeof layer["name"] === "string" ? layer["name"].trim().slice(0, 80) : "";
    const members = Array.isArray(layer["members"])
      ? layer["members"].filter((m): m is string => typeof m === "string" && /^(?:pkg|dir):./.test(m))
      : [];
    if (name === "" || members.length === 0) return null;
    const description = typeof layer["description"] === "string" && layer["description"].trim() !== ""
      ? layer["description"].trim().slice(0, 400)
      : null;
    layers.push({ name, description, members });
  }
  return layers;
}

function repoFile(c: Context, run: () => unknown) {
  try {
    return c.json(run());
  } catch (err) {
    if (err instanceof RepoFileError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

async function withWritableDb<T>(repoRoot: string, run: (db: Db) => Promise<T>): Promise<T> {
  const writeDb = openDb(indexPath(repoRoot));
  try {
    return await run(writeDb);
  } finally {
    writeDb.close();
  }
}

// ---------------------------------------------------------------------------

const ALL_ROLES: FileRole[] = [
  "source",
  "test",
  "config",
  "generated",
  "types",
  "docs",
  "asset",
  "vendor",
];

const ALL_CONFIDENCE: Confidence[] = ["exact", "likely", "ambiguous", "external", "unresolved"];

function parseRoles(raw: string | undefined): FileRole[] | undefined {
  if (!raw) return undefined;
  const parsed = raw.split(",").filter((r): r is FileRole => (ALL_ROLES as string[]).includes(r));
  return parsed.length > 0 ? parsed : undefined;
}

function parseConfidence(raw: string | undefined): Confidence[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(",")
    .filter((c): c is Confidence => (ALL_CONFIDENCE as string[]).includes(c));
  return parsed.length > 0 ? parsed : undefined;
}

function parseDirection(raw: string | undefined): "callers" | "callees" | "both" {
  return raw === "callers" || raw === "callees" ? raw : "both";
}

/**
 * Boolean query parameters are always parsed leniently.
 *
 * URLSearchParams will write true as "true", but when manually writing curl, one is used to "1", and only recognizes that.
 * One will get a switch that is permanently off and does not report errors — this trap has already been stepped on once.
 */
function parseBool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function optionalInt(raw: string | undefined): number | undefined {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The node id is in the form `file:42`, and the front end may directly pass back the entire id. */
function numericId(raw: string): number | null {
  const stripped = raw.includes(":") ? (raw.split(":").at(-1) ?? raw) : raw;
  const parsed = Number.parseInt(stripped, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
