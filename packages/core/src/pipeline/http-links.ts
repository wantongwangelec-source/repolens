import type { Db } from "../db/database.js";
import type { EdgeRow, IndexWriter, RollupEdgeRow } from "../db/writer.js";
import { dirOf } from "../resolve/path-utils.js";
import type { HttpLinkStats } from "../types.js";

/**
 * Frontend request → Backend route handler.
 *
 * There is no import between the front end and the back end; the call relationship only exists in the same URL written on both sides: the client
 * `get("/findings")`, server `api.get("/findings", handler)`. Not connecting this hop,
 * On the architecture diagram, the front end and the back end are two isolated islands, and the link from the page to the database is broken at the network boundary.
 *
 * This is a relationship inferred literally, so the edges are all likely (ambiguous when multiple routes share the same time slot).
 * Do not mix with edges proven by import:
 *   - The path is compared segment by segment, and `:id` / `{id}` / `<id>` as well as template interpolation `${id}` are all considered parameter segments;
 *   - The front-end BASE prefix and back-end mounting points like `app.route("/api", sub)` are both invisible,
 *     So it only requires the shorter side to align the entire paragraph with the end of the longer side;
 *   - You can see the methods (`post(...)`, `fetch(url, { method: "DELETE" })`, `send("POST", url)`)
 *     At that time, it only looks within the routes of the same method.
 */

type Segment = string | null;

interface Route {
  symbolId: number;
  fileId: number;
  method: string | null;
  segments: Segment[];
}

interface RequestSite {
  fileId: number;
  callerId: number | null;
  line: number;
  method: string | null;
  segments: Segment[];
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_AMBIGUOUS = 4;

export function linkHttpEdges(db: Db, writer: IndexWriter): HttpLinkStats {
  const routes = loadRoutes(db);
  if (routes.length === 0) return { routes: 0, linked: 0, ambiguous: 0 };
  const requests = loadRequests(db);

  const edges = new Map<string, EdgeRow>();
  const fileEdges = new Map<string, EdgeRow>();
  for (const request of requests) {
    const targets = matchRoutes(request, routes);
    if (targets.length === 0) continue;
    const first = targets[0] as Route;
    const srcKind = request.callerId !== null ? "symbol" : "file";
    const srcId = request.callerId ?? request.fileId;
    const key = `${srcKind}${srcId}\u0000${first.symbolId}`;
    const existing = edges.get(key);
    if (existing) existing.weight++;
    else {
      edges.set(key, {
        type: "calls", srcKind, srcId, dstKind: "symbol", dstId: first.symbolId, dstName: null,
        confidence: targets.length === 1 ? "likely" : "ambiguous", line: request.line, callKind: "http",
        candidates: targets.length === 1 ? null : targets.map((route) => route.symbolId), weight: 1,
      });
    }
    if (targets.length > 1 || request.fileId === first.fileId) continue;
    const fileKey = `${request.fileId}->${first.fileId}`;
    const fileEdge = fileEdges.get(fileKey);
    if (fileEdge) fileEdge.weight++;
    else {
      fileEdges.set(fileKey, {
        type: "http", srcKind: "file", srcId: request.fileId, dstKind: "file", dstId: first.fileId, dstName: null,
        confidence: "likely", line: null, callKind: null, candidates: null, weight: 1,
      });
    }
  }

  writer.insertEdges([...edges.values(), ...fileEdges.values()]);
  writer.insertRollupEdges(rollups(db, [...fileEdges.values()]));
  const ambiguous = [...edges.values()].filter((edge) => edge.confidence === "ambiguous").length;
  return { routes: routes.length, linked: edges.size, ambiguous };
}

function loadRoutes(db: Db): Route[] {
  const rows = db.prepare(
    `SELECT symbol_id AS symbolId, file_id AS fileId, method, route FROM entry_points
     WHERE kind = 'http' AND symbol_id IS NOT NULL AND route IS NOT NULL`,
  ).all() as Array<{ symbolId: number; fileId: number; method: string | null; route: string }>;
  const out: Route[] = [];
  for (const row of rows) {
    const segments = routeSegments(row.route);
    if (segments === null || !segments.some((segment) => segment !== null)) continue;
    out.push({ symbolId: row.symbolId, fileId: row.fileId, method: row.method?.toUpperCase() ?? null, segments });
  }
  return out;
}

function loadRequests(db: Db): RequestSite[] {
  // The route registration itself is also a 'get/post call with path literal' and must be excluded. Python decorator
  // When registering, the entry is recorded on the def line, and the decorator is on the line above it.
  const registrations = new Set<string>();
  for (const row of db.prepare("SELECT file_id AS fileId, line FROM entry_points WHERE kind = 'http'").all() as Array<{ fileId: number; line: number }>) {
    registrations.add(`${row.fileId}:${row.line}`);
    registrations.add(`${row.fileId}:${row.line - 1}`);
  }
  const rows = db.prepare(
    `SELECT c.file_id AS fileId, c.caller_symbol_id AS callerId, c.callee_name AS callee,
            c.argument_texts AS args, c.line
     FROM call_sites c JOIN files f ON f.id = c.file_id
     WHERE f.role = 'source' AND c.argument_texts LIKE '%/%'`,
  ).all() as Array<{ fileId: number; callerId: number | null; callee: string; args: string; line: number }>;

  const out: RequestSite[] = [];
  for (const row of rows) {
    if (registrations.has(`${row.fileId}:${row.line}`)) continue;
    const args = parseArgs(row.args);
    const last = args.at(-1) ?? "";
    if (args.length > 1 && /=>|^(async\s+)?function\b/.test(last)) continue;
    const segments = args.map(requestSegments).find((found) => found !== null);
    if (!segments) continue;
    out.push({ fileId: row.fileId, callerId: row.callerId, line: row.line, method: requestMethod(row.callee, args), segments });
  }
  return out;
}

/** `/repos/:id/scan`、`/users/{id}`、`/files/<int:id>` → ["repos", null, "scan"] */
export function routeSegments(route: string): Segment[] | null {
  const out: Segment[] = [];
  for (const part of (route.split(/[?#]/)[0] ?? "").split("/")) {
    if (part === "") continue;
    // Wildcard mounting (static resources, reverse proxy, fallback page) is not a specific interface
    if (part.includes("*")) return null;
    out.push(/^[:{<]/.test(part) ? null : part);
  }
  return out;
}

/**
 * The URL literal in the actual parameter → path segment. `${BASE}/repos/${id}` → ["repos", null]:
 * Interpolations at the beginning are prefixes and cannot be obtained; interpolations within segments are parameters; interpolations immediately following static segments are mostly query strings.
 */
export function requestSegments(text: string): Segment[] | null {
  const concat = /^[\w$.]+\s*\+\s*(["'`].*["'`])$/.exec(text);
  const literal = concat ? concat[1] as string : text;
  const quote = literal[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || literal.length < 2 || literal.at(-1) !== quote) return null;
  let body = literal.slice(1, -1);
  if (quote === "`") body = body.replace(/\$\{[^}]*\}/g, "\u0000");
  if (concat) body = `\u0000${body}`;
  body = body.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, "\u0000");
  body = body.split(/[?#]/)[0] ?? "";
  if (/\s/.test(body) || !(body.startsWith("/") || /^\u0000+\//.test(body))) return null;

  const out: Segment[] = [];
  for (const part of body.split("/")) {
    if (part === "") continue;
    if (/^\u0000+$/.test(part)) {
      out.push(null);
      continue;
    }
    const trimmed = part.replace(/\u0000+$/, "");
    out.push(trimmed.includes("\u0000") ? null : trimmed);
  }
  while (out[0] === null) out.shift();
  return out.some((segment) => segment !== null) ? out : null;
}

function requestMethod(callee: string, args: readonly string[]): string | null {
  const named = callee.toUpperCase();
  if (HTTP_METHODS.has(named)) return named;
  for (const arg of args) {
    const literal = /^["'`]([A-Za-z]+)["'`]$/.exec(arg)?.[1]?.toUpperCase();
    if (literal && HTTP_METHODS.has(literal)) return literal;
    const option = /\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/.exec(arg)?.[1]?.toUpperCase();
    if (option && HTTP_METHODS.has(option)) return option;
  }
  // If fetch doesn't pass the method, it's GET; if it does pass it but with variables, then it's unclear.
  if (callee === "fetch" && !args.slice(1).some((arg) => /\bmethod\b/.test(arg))) return "GET";
  return null;
}

/** The highest-scoring route; if there are ties, all are returned, leaving it to the caller to decide as ambiguous. */
function matchRoutes(request: RequestSite, routes: readonly Route[]): Route[] {
  let best = 0;
  let winners: Route[] = [];
  for (const route of routes) {
    if (request.method !== null && route.method !== null && route.method !== request.method) continue;
    const score = matchScore(request.segments, route.segments);
    if (score === null || score < best) continue;
    if (score > best) {
      best = score;
      winners = [route];
    } else {
      winners.push(route);
    }
  }
  return winners.length > MAX_AMBIGUOUS ? [] : winners;
}

/**
 * Align from the tail segment by segment. The static segment aligned scores 10 points, parameters aligned score 2 points, and if one side has a parameter, it scores 1 point.
 * Length difference (mount point, BASE prefix) deducts 1 point per segment. If not a single static segment matches, it is considered not a match.
 */
function matchScore(request: readonly Segment[], route: readonly Segment[]): number | null {
  const n = Math.min(request.length, route.length);
  let statics = 0;
  let score = 0;
  for (let i = 1; i <= n; i++) {
    const a = request[request.length - i] ?? null;
    const b = route[route.length - i] ?? null;
    if (a === null && b === null) score += 2;
    else if (a === null || b === null) score += 1;
    else if (a === b) {
      statics++;
      score += 10;
    } else return null;
  }
  if (statics === 0) return null;
  return score - Math.abs(request.length - route.length);
}

function rollups(db: Db, fileEdges: readonly EdgeRow[]): RollupEdgeRow[] {
  if (fileEdges.length === 0) return [];
  const fileInfo = db.prepare(
    `SELECT f.path, p.name AS pkg FROM files f LEFT JOIN packages p ON p.id = f.package_id WHERE f.id = ?`,
  );
  const out = new Map<string, RollupEdgeRow>();
  const bump = (level: "package" | "directory", src: string, dst: string, count: number) => {
    if (src === dst) return;
    const key = `${level}\u0000${src}\u0000${dst}`;
    const existing = out.get(key);
    if (existing) {
      existing.count += count;
      existing.weight += count;
    } else {
      out.set(key, { level, type: "http", src, dst, confidence: "likely", count, weight: count });
    }
  };
  for (const edge of fileEdges) {
    const src = fileInfo.get(edge.srcId) as { path: string; pkg: string | null } | undefined;
    const dst = fileInfo.get(edge.dstId) as { path: string; pkg: string | null } | undefined;
    if (!src || !dst) continue;
    bump("directory", dirOf(src.path), dirOf(dst.path), edge.weight);
    if (src.pkg !== null && dst.pkg !== null) bump("package", src.pkg, dst.pkg, edge.weight);
  }
  return [...out.values()];
}

function parseArgs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
