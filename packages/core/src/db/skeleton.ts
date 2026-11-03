import type { DataAccessRefDto, DataTableDto, FlowRefDto, SkeletonDto, SymbolKind, TypeFlowDto } from "../types.js";
import type { Db } from "./database.js";

const TYPE_KINDS = ["class", "interface", "struct", "type", "enum", "trait"];
const FLOW_LISTED = 40;
const TYPES_LISTED = 15;
const TABLE_REFS_LISTED = 30;

interface FunctionRow {
  id: number; name: string; container: string | null; fileId: number; path: string; line: number;
  params: string | null; returnType: string | null;
}

/**
 * How types flow in the code. Only recognize the functions in the files where it can be seen: its own file, and the files that import the file it is in,
 * And those in the same directory (Go and Rust do not need to import within the same package) — types with the same name in different modules are not counted.
 */
export function getTypeFlow(db: Db, symbolId: number): TypeFlowDto | null {
  const type = db.prepare(
    `SELECT s.id, s.name, s.kind, s.file_id AS fileId, f.path, f.dir_path AS dir, f.language
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  ).get(symbolId) as { id: number; name: string; kind: SymbolKind; fileId: number; path: string; dir: string; language: string } | undefined;
  if (!type || !TYPE_KINDS.includes(type.kind)) return null;

  const visible = visibleFiles(db, type.fileId, type.dir, type.language);
  const word = new RegExp(`(?<![\\w$.])${escape(type.name)}(?![\\w$])`);
  const functions = functionsIn(db, visible);
  const ref = (fn: FunctionRow, detail: string | null): FlowRefDto => ({
    id: `sym:${fn.id}`, name: fn.container ? `${fn.container}.${fn.name}` : fn.name, path: fn.path, line: fn.line, detail,
  });

  const consumers: FlowRefDto[] = [];
  const producers: FlowRefDto[] = [];
  for (const fn of functions) {
    if (fn.returnType && word.test(fn.returnType)) producers.push(ref(fn, fn.returnType));
    const param = paramsOf(fn).find((p) => p.type && word.test(p.type));
    if (param) consumers.push(ref(fn, `${param.name}: ${param.type}`));
  }

  const creators = (db.prepare(
    `SELECT DISTINCT s.id, s.name, s.container, s.file_id AS fileId, f.path, c.line, NULL AS params, NULL AS returnType
     FROM call_sites c JOIN symbols s ON s.id = c.caller_symbol_id JOIN files f ON f.id = s.file_id
     WHERE c.call_kind = 'new' AND c.target_symbol_id = ? AND f.role = 'source' ORDER BY f.path, c.line`,
  ).all(symbolId) as FunctionRow[]).map((fn) => ref(fn, `new ${type.name}()`));

  const implementers = (db.prepare(
    `SELECT s.id, s.name, s.container, s.file_id AS fileId, f.path, s.start_line AS line, t.relation AS detail
     FROM type_relations t JOIN symbols s ON s.id = t.subject_id JOIN files f ON f.id = s.file_id
     WHERE t.target_id = ? ORDER BY f.path`,
  ).all(symbolId) as Array<FunctionRow & { detail: string }>).map((fn) => ref(fn, fn.detail));

  const importers = (db.prepare(
    `SELECT COUNT(DISTINCT i.file_id) AS n FROM imports i JOIN import_specifiers sp ON sp.import_id = i.id
     WHERE i.target_file_id = ? AND sp.imported = ?`,
  ).get(type.fileId, type.name) as { n: number }).n;

  return {
    id: `sym:${type.id}`,
    name: type.name,
    kind: type.kind,
    path: type.path,
    creators: creators.slice(0, FLOW_LISTED),
    producers: producers.slice(0, FLOW_LISTED),
    consumers: consumers.slice(0, FLOW_LISTED),
    implementers: implementers.slice(0, FLOW_LISTED),
    importers,
  };
}

/**
 * The skeleton of the system: the types most frequently referenced by function signatures, and the data tables read and written in SQL. To understand a system, one often first needs to
 * Understand its data — these types and tables are that data map.
 */
export function getSkeleton(db: Db): SkeletonDto {
  const types = db.prepare(
    `SELECT s.id, s.name, s.kind, s.file_id AS fileId, f.path, f.dir_path AS dir, f.language, s.start_line AS line
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.role = 'source' AND s.kind IN (${TYPE_KINDS.map(() => "?").join(",")}) AND s.container IS NULL`,
  ).all(...TYPE_KINDS) as Array<{ id: number; name: string; kind: SymbolKind; fileId: number; path: string; dir: string; language: string; line: number }>;

  // First, build an inverted index for the names that appear in each function signature, then check each type individually to avoid a full scan of "type × function".
  const functions = functionsIn(db, null);
  const byToken = new Map<string, Array<{ fn: FunctionRow; produces: boolean }>>();
  for (const fn of functions) {
    const seen = new Set<string>();
    const add = (text: string | null | undefined, produces: boolean) => {
      for (const token of (text ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []) {
        const key = `${token}\u0000${produces}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket = byToken.get(token);
        const item = { fn, produces };
        if (bucket) bucket.push(item); else byToken.set(token, [item]);
      }
    };
    add(fn.returnType, true);
    for (const param of paramsOf(fn)) add(param.type, false);
  }
  const importsOf = importIndex(db);
  const dirOf = new Map((db.prepare("SELECT id, dir_path AS dir FROM files").all() as Array<{ id: number; dir: string }>).map((r) => [r.id, r.dir]));

  const ranked = types.map((type) => {
    const hits = byToken.get(type.name) ?? [];
    const sameDir = type.language === "go" || type.language === "rust";
    const visibleHits = hits.filter(({ fn }) =>
      fn.fileId === type.fileId || importsOf.get(fn.fileId)?.has(type.fileId) || (sameDir && dirOf.get(fn.fileId) === type.dir));
    const producers = new Set(visibleHits.filter((h) => h.produces).map((h) => h.fn.id));
    const consumers = new Set(visibleHits.filter((h) => !h.produces).map((h) => h.fn.id));
    const uses = new Set([...producers, ...consumers]).size;
    return { id: `sym:${type.id}`, name: type.name, kind: type.kind, path: type.path, line: type.line, uses, producers: producers.size, consumers: consumers.size };
  });

  return {
    types: ranked.filter((t) => t.uses > 0).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, TYPES_LISTED),
    tables: dataTables(db),
  };
}

export function dataTables(db: Db, table?: string): DataTableDto[] {
  const rows = db.prepare(
    `SELECT d.table_name AS name, d.write, d.symbol_id AS symbolId, d.line, f.path,
            COALESCE(CASE WHEN s.container IS NULL THEN s.name ELSE s.container || '.' || s.name END, f.name) AS caller
     FROM data_access d JOIN files f ON f.id = d.file_id LEFT JOIN symbols s ON s.id = d.symbol_id
     ${table ? "WHERE d.table_name = ?" : ""}
     ORDER BY d.table_name, f.path, d.line`,
  ).all(...(table ? [table] : [])) as Array<{ name: string; write: number; symbolId: number | null; line: number; path: string; caller: string }>;
  const tables = new Map<string, { reads: Map<string, DataAccessRefDto>; writes: Map<string, DataAccessRefDto> }>();
  for (const row of rows) {
    const entry = tables.get(row.name) ?? { reads: new Map(), writes: new Map() };
    tables.set(row.name, entry);
    const bucket = row.write ? entry.writes : entry.reads;
    const key = row.symbolId === null ? `${row.path}:${row.line}` : `sym:${row.symbolId}`;
    if (!bucket.has(key)) {
      bucket.set(key, { symbolId: row.symbolId === null ? null : `sym:${row.symbolId}`, name: row.caller, path: row.path, line: row.line });
    }
  }
  return [...tables]
    .map(([name, entry]) => ({
      name,
      reads: [...entry.reads.values()].slice(0, TABLE_REFS_LISTED),
      writes: [...entry.writes.values()].slice(0, TABLE_REFS_LISTED),
    }))
    .sort((a, b) => b.writes.length + b.reads.length - (a.writes.length + a.reads.length) || a.name.localeCompare(b.name));
}

function visibleFiles(db: Db, fileId: number, dir: string, language: string): Set<number> {
  const out = new Set([fileId]);
  for (const row of db.prepare("SELECT DISTINCT file_id AS id FROM imports WHERE target_file_id = ?").all(fileId) as Array<{ id: number }>) {
    out.add(row.id);
  }
  if (language === "go" || language === "rust") {
    for (const row of db.prepare("SELECT id FROM files WHERE dir_path = ?").all(dir) as Array<{ id: number }>) out.add(row.id);
  }
  return out;
}

function functionsIn(db: Db, files: ReadonlySet<number> | null): FunctionRow[] {
  const rows = db.prepare(
    `SELECT s.id, s.name, s.container, s.file_id AS fileId, f.path, s.start_line AS line, s.params, s.return_type AS returnType
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.role = 'source' AND s.kind IN ('function', 'method') AND (s.params IS NOT NULL OR s.return_type IS NOT NULL)`,
  ).all() as FunctionRow[];
  return files === null ? rows : rows.filter((row) => files.has(row.fileId));
}

function paramsOf(fn: FunctionRow): Array<{ name: string; type?: string | null }> {
  if (!fn.params) return [];
  try {
    const parsed = JSON.parse(fn.params) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<{ name: string; type?: string | null }>) : [];
  } catch {
    return [];
  }
}

function importIndex(db: Db): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const row of db.prepare("SELECT file_id AS src, target_file_id AS dst FROM imports WHERE target_file_id IS NOT NULL").all() as Array<{ src: number; dst: number }>) {
    const set = out.get(row.src);
    if (set) set.add(row.dst); else out.set(row.src, new Set([row.dst]));
  }
  return out;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
