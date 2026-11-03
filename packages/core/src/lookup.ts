import type { Db } from "./db/database.js";
import { ROOT_SCOPE } from "./db/queries.js";
import type { FileRole, SymbolKind } from "./types.js";

export type LookupResult =
  | { kind: "found"; id: string }
  | { kind: "ambiguous"; candidates: LookupCandidate[] }
  | { kind: "missing" };

export interface LookupCandidate {
  id: string;
  label: string;
  symbolKind: SymbolKind;
  path: string;
  line: number;
  role: FileRole;
}

const CANDIDATE_LIMIT = 12;
const MISSING: LookupResult = { kind: "missing" };

/**
 * Replace casual quotes written by people or AI with graph nodes: node id (`sym:12`, `pkg:core`), stable reference
 * (`symbol:path#Name`, `path:file`), `path#Name`, package name, directory or file path, and function name
 * (A container can be provided, such as `IndexWriter.upsertFile`). Symbols with the same name should not require the caller to guess; list the candidates and let it choose.
 * Does `want` limit only the scope (package, directory, file) or only symbols?
 */
export function lookupNode(db: Db, text: string, want: "scope" | "symbol" | "any" = "any"): LookupResult {
  const ref = text.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (ref.length === 0) return MISSING;
  const explicit = explicitRef(db, ref);
  if (explicit) {
    const wanted = want === "any" || want === explicit.kind;
    return wanted && explicit.id !== null ? { kind: "found", id: explicit.id } : MISSING;
  }
  if (want !== "symbol") {
    const scope = scopeByPath(db, ref);
    if (scope !== null) return { kind: "found", id: scope };
  }
  return want === "scope" ? MISSING : symbolByName(db, ref);
}

/** Prefixed notation: the notation itself indicates whether a range or a symbol is required; when the object does not exist, the id is null */
function explicitRef(db: Db, ref: string): { kind: "scope" | "symbol"; id: string | null } | null {
  const prefixed = /^(pkg|dir|file|sym):(.+)$/.exec(ref);
  if (prefixed) {
    const [, prefix, rest] = prefixed;
    if (prefix === "sym") return { kind: "symbol", id: rowExists(db, "symbols", rest!) ? ref : null };
    if (prefix === "file") return { kind: "scope", id: rowExists(db, "files", rest!) ? ref : null };
    return { kind: "scope", id: ref === ROOT_SCOPE ? ROOT_SCOPE : resolveRef(db, ref) };
  }
  if (ref.startsWith("symbol:")) return { kind: "symbol", id: resolveRef(db, ref) };
  if (ref.startsWith("path:")) return { kind: "scope", id: resolveRef(db, ref) };
  if (ref.includes("#")) return { kind: "symbol", id: resolveRef(db, `symbol:${ref}`) };
  return null;
}

/** References written by path and name are replaced with nodes in the current index: node IDs change with each scan, paths and names do not; null if the object does not exist. */
function resolveRef(db: Db, ref: string): string | null {
  if (ref.startsWith("pkg:")) return db.prepare("SELECT 1 FROM packages WHERE name = ?").get(ref.slice(4)) ? ref : null;
  if (ref.startsWith("dir:")) return db.prepare("SELECT 1 FROM directories WHERE path = ?").get(ref.slice(4)) ? ref : null;
  if (ref.startsWith("path:")) {
    const row = db.prepare("SELECT id FROM files WHERE path = ?").get(ref.slice(5)) as { id: number } | undefined;
    return row ? `file:${row.id}` : null;
  }
  if (ref.startsWith("symbol:")) {
    const rest = ref.slice(7);
    const hash = rest.lastIndexOf("#");
    if (hash < 0) return null;
    const path = rest.slice(0, hash);
    const qualified = rest.slice(hash + 1);
    const dot = qualified.lastIndexOf(".");
    const container = dot >= 0 ? qualified.slice(0, dot) : null;
    const name = dot >= 0 ? qualified.slice(dot + 1) : qualified;
    const row = db.prepare(
      `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE f.path = ? AND s.name = ? AND s.container IS ? ORDER BY s.start_line LIMIT 1`,
    ).get(path, name, container) as { id: number } | undefined;
    return row ? `sym:${row.id}` : null;
  }
  return null;
}

function scopeByPath(db: Db, ref: string): string | null {
  if (ref === "repo" || ref === ".") return ROOT_SCOPE;
  if (db.prepare("SELECT 1 FROM packages WHERE name = ?").get(ref)) return `pkg:${ref}`;
  const pkg = db.prepare("SELECT name FROM packages WHERE dir = ? AND dir != '.'").get(ref) as { name: string } | undefined;
  if (pkg) return `pkg:${pkg.name}`;
  if (db.prepare("SELECT 1 FROM directories WHERE path = ?").get(ref)) return `dir:${ref}`;
  const file = db.prepare("SELECT id FROM files WHERE path = ?").get(ref) as { id: number } | undefined;
  return file ? `file:${file.id}` : null;
}

function symbolByName(db: Db, ref: string): LookupResult {
  const dot = ref.lastIndexOf(".");
  const name = dot > 0 ? ref.slice(dot + 1) : ref;
  const container = dot > 0 ? ref.slice(0, dot) : null;
  const rows = db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.start_line AS line, f.path, f.role FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE s.name = ? AND (? IS NULL OR s.container = ?)
     ORDER BY f.role = 'source' DESC, s.exported DESC, f.path, s.start_line
     LIMIT ${CANDIDATE_LIMIT + 1}`,
  ).all(name, container, container) as Array<{
    id: number; name: string; container: string | null; kind: SymbolKind; line: number; path: string; role: FileRole;
  }>;
  if (rows.length === 0) return MISSING;
  if (rows.length === 1) return { kind: "found", id: `sym:${rows[0]!.id}` };
  return {
    kind: "ambiguous",
    candidates: rows.slice(0, CANDIDATE_LIMIT).map((row) => ({
      id: `sym:${row.id}`,
      label: row.container ? `${row.container}.${row.name}` : row.name,
      symbolKind: row.kind,
      path: row.path,
      line: row.line,
      role: row.role,
    })),
  };
}

function rowExists(db: Db, table: "files" | "symbols", id: string): boolean {
  return /^\d+$/.test(id) && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(id)) !== undefined;
}
