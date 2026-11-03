import { publicApiFileIds } from "../db/architecture.js";
import type { Db } from "../db/database.js";
import type { EntryPointKind, IoKind } from "../types.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "options", "head", "all", "route",
]);
const TEST_NAMES = /^(test|it|describe|specify)$/i;

/** Further down, the I/O no longer has guiding significance for 'whether to proceed with this step'. */
const IO_REACH_DEPTH = 10;
/** The scale of the entry is just a magnitude hint; stop counting here to avoid having the hot entry traverse the entire call graph. */
const REACH_CAP = 999;

const IO_ORDER: readonly IoKind[] = ["database", "network", "filesystem", "message-queue", "process"];

interface SymbolRow {
  id: number; fileId: number; fileRole: string; name: string; container: string | null;
  exported: number; startLine: number; testKind: "case" | "suite" | null;
}

interface CallRow {
  id: number; fileId: number; callerId: number | null; callee: string; receiver: string | null;
  receiverType: string | null; arguments: string; line: number;
  /** The package name it falls to when parsed as external */
  external: string | null;
}

interface EntryCandidate {
  kind: EntryPointKind; framework: string | null; symbolId: number | null; fileId: number; line: number; label: string;
  method: string | null; route: string | null; confidence: "exact" | "likely"; evidence: string;
}

export interface EntryAnalysisStats { entries: number; ioSites: number; }

/**
 * Entry recognition, I/O call point annotation, and reachability hints for single-step walkthroughs. Read-only parsing facts and
 * The result of calling the link does not involve the LLM: when the model is unavailable, each step of the workflow still falls on the specific call line.
 */
export function analyzeEntries(db: Db): EntryAnalysisStats {
  db.exec("DELETE FROM io_reach; DELETE FROM entry_points");

  const symbols = loadSymbols(db);
  const calls = loadCalls(db);
  const entries = dedupeEntries([
    ...symbolEntries(db, symbols),
    ...hintEntries(db, symbols),
    ...registrationEntries(calls, symbols),
    ...testCallEntries(calls, symbols),
  ]);

  db.prepare("UPDATE call_sites SET io_kind = NULL WHERE io_kind IS NOT NULL").run();
  const markIo = db.prepare("UPDATE call_sites SET io_kind = ? WHERE id = ?");
  const ioBySymbol = new Map<number, Set<IoKind>>();
  let ioSites = 0;
  const libraries = new Set(
    (db.prepare("SELECT DISTINCT external_name AS name FROM imports WHERE external_name IS NOT NULL").all() as Array<{
      name: string;
    }>).map((row) => row.name),
  );
  for (const call of calls) {
    const kind = classifyIo(call, libraries);
    if (!kind) continue;
    markIo.run(kind, call.id);
    ioSites++;
    if (call.callerId === null) continue;
    const bucket = ioBySymbol.get(call.callerId);
    if (bucket) bucket.add(kind); else ioBySymbol.set(call.callerId, new Set([kind]));
  }

  const adjacency = loadEdges(db);
  const reach = ioReach(adjacency, ioBySymbol, IO_REACH_DEPTH);
  const insertReach = db.prepare("INSERT INTO io_reach (symbol_id, kind, depth) VALUES (?, ?, ?)");
  for (const [symbolId, kinds] of reach) {
    for (const [kind, depth] of kinds) insertReach.run(symbolId, kind, depth);
  }

  // `new Foo()` falls on the class symbol, and the number of files should be counted together with them
  const fileOf = new Map(
    (db.prepare("SELECT id, file_id AS fileId FROM symbols").all() as Array<{ id: number; fileId: number }>)
      .map((row) => [row.id, row.fileId]),
  );
  const insertEntry = db.prepare(
    `INSERT INTO entry_points
       (kind, framework, symbol_id, file_id, line, label, method, route, confidence, evidence,
        reach_symbols, reach_files, reach_io)
     VALUES (@kind, @framework, @symbolId, @fileId, @line, @label, @method, @route, @confidence, @evidence,
        @reachSymbols, @reachFiles, @reachIo)`,
  );
  for (const entry of entries) {
    const scale = entry.symbolId === null ? null : reachScale(entry.symbolId, adjacency, fileOf);
    const io = entry.symbolId === null ? [] : IO_ORDER.filter((kind) => reach.get(entry.symbolId!)?.has(kind));
    insertEntry.run({
      ...entry,
      reachSymbols: scale?.symbols ?? 0,
      reachFiles: scale?.files ?? 0,
      reachIo: io.join(","),
    });
  }

  return { entries: entries.length, ioSites };
}

function loadSymbols(db: Db): SymbolRow[] {
  return db.prepare(
    `SELECT s.id, s.file_id AS fileId, f.role AS fileRole, s.name, s.container,
            s.exported, s.start_line AS startLine, s.test_kind AS testKind
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.kind IN ('function', 'method')`,
  ).all() as SymbolRow[];
}

function loadCalls(db: Db): CallRow[] {
  return db.prepare(
    `SELECT id, file_id AS fileId, caller_symbol_id AS callerId, callee_name AS callee, receiver,
            receiver_type AS receiverType, argument_texts AS arguments, line, target_name AS external
     FROM call_sites`,
  ).all() as CallRow[];
}
function symbolEntries(db: Db, symbols: readonly SymbolRow[]): EntryCandidate[] {
  const out: EntryCandidate[] = [];
  const publicApiFiles = publicApiFileIds(db);
  for (const symbol of symbols) {
    if (symbol.name === "main") {
      out.push(entryFromSymbol(symbol, "main", "main", "语言约定的 main 函数", "exact"));
    }
    if (
      symbol.fileRole === "source" && symbol.name !== "main" &&
      symbol.exported === 1 && symbol.container === null && publicApiFiles.has(symbol.fileId)
    ) {
      out.push(entryFromSymbol(symbol, "public-api", qualifiedName(symbol), "导出的顶层函数", "exact"));
    }
    // Test cases: callbacks composed with `it("…", () => …)`, or test functions in test files named according to conventions
    if (symbol.testKind === "case") {
      out.push(entryFromSymbol(symbol, "test", qualifiedName(symbol), "测试用例", "exact"));
    }
  }
  return out;
}

function hintEntries(db: Db, symbols: readonly SymbolRow[]): EntryCandidate[] {
  const byFileAndName = new Map(symbols.map((s) => [`${s.fileId}:${s.name}`, s]));
  const rows = db.prepare(
    `SELECT file_id AS fileId, kind, framework, handler_name AS handlerName, line, label, method, route, confidence, evidence
     FROM entry_hints`,
  ).all() as Array<{ fileId: number; kind: "http" | "cli"; framework: string; handlerName: string | null;
    line: number; label: string; method: string | null; route: string | null; confidence: "exact" | "likely"; evidence: string }>;
  return rows.map((row) => ({
    kind: row.kind, framework: row.framework, symbolId: row.handlerName ? byFileAndName.get(`${row.fileId}:${row.handlerName}`)?.id ?? null : null,
    fileId: row.fileId, line: row.line, label: row.label, method: row.method, route: row.route,
    confidence: row.confidence, evidence: row.evidence,
  }));
}

function registrationEntries(calls: readonly CallRow[], symbols: readonly SymbolRow[]): EntryCandidate[] {
  const out: EntryCandidate[] = [];
  for (const call of calls) {
    const method = call.callee.toLowerCase();
    const args = parseArray(call.arguments);

    if (isCliRegistration(call)) {
      const named = resolveHandler(symbols, call.fileId, handlerIdentifier(args.at(-1) ?? ""));
      const command = unquote(args[0])?.trim().split(/\s+/)[0] || commandFromReceiver(call.receiver)
        || named?.symbol.name || call.callee;
      const handler = named ?? inlineHandler(symbols, call.fileId, `CLI ${command}`, call.line);
      out.push({
        kind: "cli", framework: cliFramework(call.callee, call.receiver),
        // The outer function where the registration call is made is not the handler; when an anonymous closure has no independent symbol, it is preferable
        // Only recognize the entry point and do not treat the outer initialization function as the starting point for walkthrough.
        symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
        label: `CLI ${command}`, method: null, route: null, confidence: handler?.confidence ?? "likely",
        evidence: `${call.receiver ? `${call.receiver}.` : ""}${call.callee}(command, handler) registration`,
      });
    }

    if (!HTTP_METHODS.has(method) || !call.receiver) continue;
    const route = unquote(args[0]);
    if (!route?.startsWith("/")) continue;
    const label = `${method === "route" || method === "all" ? "HTTP" : method.toUpperCase()} ${route}`;
    const handler = resolveHandler(symbols, call.fileId, handlerIdentifier(args.at(-1) ?? ""))
      ?? inlineHandler(symbols, call.fileId, label, call.line);
    const framework = httpFramework(call.receiver, call.callee, args);
    out.push({
      kind: "http", framework, symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
      label,
      method: method === "route" || method === "all" ? null : method.toUpperCase(), route,
      confidence: handler?.confidence ?? "likely",
      evidence: `${call.receiver}.${call.callee}(route, handler) registration`,
    });
  }
  return out;
}

/** Generic command/action/handler names themselves do not constitute CLI evidence. */
function isCliRegistration(call: CallRow): boolean {
  const method = call.callee.toLowerCase();
  const receiver = (call.receiver ?? "").toLowerCase();
  if (/^(addcommand|add_command|subcommand)$/.test(method)) return receiver.length > 0;
  if (method === "command") return /(?:^|[.(_])(program|commander|yargs|cli|cmd)(?:$|[.)_])/.test(receiver);
  if (method === "action") return /program|commander|command|yargs|cli|cmd/.test(receiver);
  if (method === "handler") return /command|yargs|cli/.test(receiver);
  return false;
}

function cliFramework(callee: string, receiver: string | null): string {
  if (/add_command/i.test(callee)) return "Click/Typer";
  if (/addcommand/i.test(callee)) return "Cobra";
  if (/command|action/i.test(callee) && /program|commander|cmd/i.test(receiver ?? "")) return "Commander";
  return "CLI framework";
}

/**
 * `it("…", handler)` type of registration call. Inline callbacks have already been merged into test case symbols and collected by symbolEntries;
 * This supplement shows the approach of passing in a named function. Registration can be done inside describe, and the caller is the test suite, which can be handled as is.
 */
function testCallEntries(calls: readonly CallRow[], symbols: readonly SymbolRow[]): EntryCandidate[] {
  const suites = new Set(symbols.filter((s) => s.testKind === "suite").map((s) => s.id));
  const out: EntryCandidate[] = [];
  for (const call of calls) {
    if (!TEST_NAMES.test(call.callee) || /^describe$/i.test(call.callee)) continue;
    if (call.callerId !== null && !suites.has(call.callerId)) continue;
    const args = parseArray(call.arguments);
    const title = unquote(args[0]);
    const inline = title ? inlineHandler(symbols, call.fileId, title.slice(0, 160), call.line) : null;
    const handler = inline ?? resolveHandler(symbols, call.fileId, handlerIdentifier(args.at(-1) ?? ""));
    out.push({
      kind: "test", framework: null, symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
      label: title ?? `${call.callee} @ ${call.line}`, method: null, route: null,
      confidence: handler?.confidence ?? "likely", evidence: `${call.callee}(name, callback) test registration`,
    });
  }
  return out;
}

/** Calling something that directly falls into these packages counts as I/O; for Node built-in modules, remove the `node:` prefix before checking */
const PACKAGE_IO: Readonly<Record<string, IoKind>> = Object.fromEntries([
  ...[
    "better-sqlite3", "sqlite3", "sqlite", "pg", "postgres", "mysql", "mysql2", "mongodb", "mongoose", "redis",
    "ioredis", "@prisma/client", "knex", "typeorm", "sequelize", "drizzle-orm", "kysely", "@libsql/client",
    "sqlalchemy", "psycopg", "psycopg2", "pymysql", "pymongo", "database/sql", "gorm.io/gorm",
    "github.com/jmoiron/sqlx", "rusqlite", "sqlx", "diesel",
  ].map((name) => [name, "database"]),
  ...[
    "axios", "node-fetch", "got", "undici", "superagent", "ky", "http", "https", "http2", "net", "dns",
    "requests", "httpx", "aiohttp", "urllib.request", "urllib3", "net/http", "reqwest", "hyper",
  ].map((name) => [name, "network"]),
  ...["fs", "fs/promises", "fs-extra", "graceful-fs", "shutil", "io/ioutil", "std::fs", "tokio::fs"]
    .map((name) => [name, "filesystem"]),
  ...["child_process", "execa", "cross-spawn", "subprocess", "os/exec", "std::process"].map((name) => [name, "process"]),
  ...[
    "kafkajs", "amqplib", "bullmq", "bull", "@aws-sdk/client-sqs", "nats", "pika", "kafka-python", "confluent_kafka",
    "github.com/segmentio/kafka-go", "lapin", "rdkafka",
  ].map((name) => [name, "message-queue"]),
]);

/**
 * Identify I/O access based on the arrived package, API name, and receiver. Just a note: when reading this line, tell people 'here we hit the database'.
 * Don't treat it as the end — the function can still continue moving forward.
 */
function classifyIo(
  call: Pick<CallRow, "callee" | "receiver" | "receiverType" | "external">,
  libraries: ReadonlySet<string>,
): IoKind | null {
  // Chained calls on the results of other calls (like `s.split()` after `const s = fs.readFileSync(…)`) are just borrowing the name of that library.
  // The return value is mostly ordinary data and does not count as I/O.
  const derived = (call.receiver ?? "").includes("(") || /^[RAM]:/.test(call.receiverType ?? "");
  const byPackage = call.external && !derived ? PACKAGE_IO[call.external.replace(/^node:/, "")] : undefined;
  if (byPackage) return byPackage;
  const callee = call.callee.toLowerCase();
  const receiver = (call.receiver ?? "").toLowerCase();

  if (/^(query|queryrow|execute|exec|transaction|findunique|findmany|findone|findall|insert|upsert|save|commit|rollback)$/.test(callee) &&
      /(^|\.|_)(db|sql|sqlx|database|pool|connection|conn|cursor|session|prisma|sequelize|knex|repository|repo|collection|model)(\.|_|$)/.test(receiver)) {
    return "database";
  }
  if (/^(readfile|readfilesync|writefile|writefilesync|appendfile|appendfilesync|createreadstream|createwritestream|readdir|readdirsync|mkdir|mkdirsync|unlink|unlinksync|read_to_string|read_dir)$/.test(callee) ||
      (/^(open|create|remove|rmtree|rm|rmsync)$/.test(callee) && /(^|\.)(fs|fse|file|path|pathlib|os|shutil)$/.test(receiver)) ||
      // Python's built-in open; the package called open on npm is for opening the browser. Once you import it, it's not the same thing.
      (callee === "open" && call.external === "open" && !libraries.has("open"))) {
    return "filesystem";
  }
  // `program.command("scan")` is for registering a CLI subcommand, not for starting a process
  if (/^(spawn|execfile|execsync|spawnsync|execfilesync|popen)$/.test(callee) ||
      (callee === "system" && (receiver === "" || receiver === "os")) ||
      (callee === "exec" && (receiver === "" || /child_process|command|process/.test(receiver))) ||
      (callee === "run" && /subprocess|command|process/.test(receiver)) ||
      (callee === "new" && /(^|::|\.)command$/.test(receiver))) {
    return "process";
  }
  if (/^(publish|basic_publish|subscribe|basic_consume|sendmessage|sendmessages|receivemessage|sendtoqueue|consume|produce|enqueue|dequeue|ack|nack|xadd|lpush|rpush)$/.test(callee) &&
      /queue|kafka|rabbit|channel|sqs|pubsub|broker|producer|consumer/.test(receiver)) {
    return "message-queue";
  }
  // The receiver should end with the name of the HTTP client: `overviewRequests.delete(key)` is a Map operation
  if ((callee === "fetch" && /^(|window|globalthis|self)$/.test(receiver)) || /^(axios|got|requesturl|urlopen)$/.test(callee) ||
      (/^(get|post|put|patch|delete|send|request|do)$/.test(callee) &&
        /(^|[._])(https?|axios|requests|httpx|urllib\d?|got|ky|superagent|(http|api|rest)_?client)$/.test(receiver)) ||
      (callee === "do" && /(^|[._])client$/.test(receiver))) {
    return "network";
  }
  if (/^(get|all|run|prepare)$/.test(callee) && /(^|\.|_)(db|sql|database)(\.|_|$)/.test(receiver)) {
    return "database";
  }
  return null;
}

/** Only follow definite and possible calls: ambiguous edges are guesses, using them to infer 'the database will be touched here' is like amplifying the guess one more round */
function loadEdges(db: Db): Map<number, number[]> {
  const rows = db.prepare(
    `SELECT src_id AS "from", dst_id AS "to" FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
       AND confidence IN ('exact', 'likely')`,
  ).all() as Array<{ from: number; to: number }>;
  const out = new Map<number, number[]>();
  for (const edge of rows) {
    const bucket = out.get(edge.from);
    if (bucket) bucket.push(edge.to); else out.set(edge.from, [edge.to]);
  }
  return out;
}

/** Each type of I/O spreads backward from the function that 'is doing it itself', noting for each caller the minimum number of hops needed to reach it. */
function ioReach(
  adjacency: ReadonlyMap<number, readonly number[]>,
  ioBySymbol: ReadonlyMap<number, ReadonlySet<IoKind>>,
  maxDepth: number,
): Map<number, Map<IoKind, number>> {
  const reverse = new Map<number, number[]>();
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      const bucket = reverse.get(to);
      if (bucket) bucket.push(from); else reverse.set(to, [from]);
    }
  }
  const out = new Map<number, Map<IoKind, number>>();
  for (const kind of IO_ORDER) {
    let frontier = [...ioBySymbol].filter(([, kinds]) => kinds.has(kind)).map(([id]) => id);
    const seen = new Set(frontier);
    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        const kinds = out.get(id);
        if (kinds) kinds.set(kind, depth); else out.set(id, new Map([[kind, depth]]));
        for (const caller of reverse.get(id) ?? []) {
          if (seen.has(caller)) continue;
          seen.add(caller);
          next.push(caller);
        }
      }
      frontier = next;
    }
  }
  return out;
}

/** From the entry point, how many internal functions in the warehouses can be reached, and how many other files can be exited from the entry file. It is a magnitude used for sorting the entry list and indicating the scale. */
function reachScale(
  start: number,
  adjacency: ReadonlyMap<number, readonly number[]>,
  fileOf: ReadonlyMap<number, number>,
): { symbols: number; files: number } {
  const seen = new Set([start]);
  const files = new Set<number>();
  const startFile = fileOf.get(start);
  const queue = [start];
  while (queue.length > 0 && seen.size <= REACH_CAP) {
    const id = queue.shift() as number;
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const file = fileOf.get(next);
      if (file !== undefined && file !== startFile) files.add(file);
      queue.push(next);
    }
  }
  return { symbols: Math.min(seen.size - 1, REACH_CAP), files: files.size };
}

function entryFromSymbol(symbol: SymbolRow, kind: EntryPointKind, label: string, evidence: string, confidence: "exact" | "likely"): EntryCandidate {
  return { kind, framework: null, symbolId: symbol.id, fileId: symbol.fileId, line: symbol.startLine, label, method: null, route: null, confidence, evidence };
}

function resolveHandler(
  symbols: readonly SymbolRow[], fileId: number, name: string | null,
): { symbol: SymbolRow; confidence: "exact" | "likely" } | null {
  if (!name) return null;
  const local = symbols.filter((s) => s.fileId === fileId && s.name === name);
  if (local.length === 1) return { symbol: local[0] as SymbolRow, confidence: "exact" };
  const exported = symbols.filter((s) => s.exported === 1 && s.name === name);
  // Cross-file binding has not yet been proven along the import specifier and can only continue to use the likely semantics of the call linker.
  return exported.length === 1
    ? { symbol: exported[0] as SymbolRow, confidence: "likely" }
    : null;
}

/**
 * The parser synthesizes symbols for the inline callbacks in registered calls (using the same rules as names and entry labels, with `#n` appended if there are duplicate names).
 * The callback always starts on or after the line where it is registered; take the one closest to it.
 */
function inlineHandler(
  symbols: readonly SymbolRow[], fileId: number, name: string, line: number,
): { symbol: SymbolRow; confidence: "exact" } | null {
  let best: SymbolRow | null = null;
  for (const symbol of symbols) {
    if (symbol.fileId !== fileId || symbol.container !== null || symbol.startLine < line) continue;
    if (symbol.name !== name && !symbol.name.startsWith(`${name} #`)) continue;
    if (!best || symbol.startLine < best.startLine) best = symbol;
  }
  return best ? { symbol: best, confidence: "exact" } : null;
}

function commandFromReceiver(receiver: string | null): string | null {
  const match = receiver?.match(/\.command\(\s*["'`]([^"'`\s]+)/);
  return match?.[1] ?? null;
}

function handlerIdentifier(text: string): string | null {
  // Axum `.route("/x", get(handler))` versus the normal `app.get("/x", handler)`.
  const value = text.trim();
  if (/^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/.test(value)) return null;
  const wrapped = value.match(/^(?:get|post|put|patch|delete|head|options)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)$/i);
  if (wrapped?.[1]) return wrapped[1];
  const direct = value.match(/^(?:[A-Za-z_$][\w$]*[.:])*([A-Za-z_$][\w$]*)$/);
  return direct?.[1] ?? null;
}

function httpFramework(receiver: string, callee: string, args: readonly string[]): string {
  if (/fastify/i.test(receiver)) return "Fastify";
  if (callee === callee.toUpperCase()) return "Gin";
  if (callee.toLowerCase() === "route" && /^(get|post|put|patch|delete)\s*\(/i.test(args[1] ?? "")) return "Axum";
  return "Express-compatible";
}

function qualifiedName(symbol: SymbolRow): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

function parseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function unquote(text: string | undefined): string | null {
  if (!text || text.length < 2) return null;
  const quote = text[0];
  return (quote === "'" || quote === '"' || quote === "`") && text.at(-1) === quote ? text.slice(1, -1) : null;
}

function dedupeEntries(entries: EntryCandidate[]): EntryCandidate[] {
  // `program.command("scan").action(fn)` registers twice on the same line: only the action one carries out the handler
  const out = new Map<string, EntryCandidate>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.fileId}:${entry.line}:${entry.route ?? ""}:${entry.label}`;
    const existing = out.get(key);
    if (!existing || (existing.symbolId === null && entry.symbolId !== null)) out.set(key, entry);
  }
  // Starting from the callback line of the use case symbol, when the registration call is on the previous line, the two line numbers do not match, and it is collected again according to the same use case where it lands.
  // For testing only: The same handler attached to two routes is two entrances
  const tests = new Set<number>();
  return [...out.values()].filter((entry) => {
    if (entry.kind !== "test" || entry.symbolId === null) return true;
    if (tests.has(entry.symbolId)) return false;
    tests.add(entry.symbolId);
    return true;
  });
}
