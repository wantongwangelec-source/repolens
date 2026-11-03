import type {
  BoundaryDto,
  BoundaryImportDto,
  BoundarySymbolDto,
  ConfirmedLayer,
  EntryPointKind,
  FileRole,
  IoKind,
  ModuleApiDto,
  ModuleCardDto,
  ModuleLinkDto,
  SymbolKind,
} from "../types.js";
import { hasPackageGraph, packageEntryFileIds } from "./architecture.js";
import type { Db } from "./database.js";
import { commitCounts } from "./file-history.js";
import { confirmedLayers } from "./queries.js";
import { inBatches, resolveScope, type NodeScope } from "./scope.js";
import { casesReaching } from "./spec.js";

const NODE_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx", "vue", "svelte", "astro"]);
const MAX_PATH_HOPS = 8;
const MAX_IMPORTS_LISTED = 200;

interface ImportRow {
  id: number; fromId: number; fromPath: string; fromPackage: number | null; toId: number; toPath: string; toPackage: number | null;
  line: number; typeOnly: number; language: string;
}

/**
 * What constitutes a dependency edge: the import between two sides, the symbols used, and the corresponding HTTP route.
 * When there is no direct dependency between two nodes, provide the shortest file-level import chain and answer 'why it depends on that side'.
 */
export function getBoundary(db: Db, fromId: string, toId: string, roles: readonly FileRole[] = ["source"]): BoundaryDto | null {
  const from = resolveScope(db, fromId, roles);
  const to = resolveScope(db, toId, roles);
  if (!from || !to) return null;
  const toFiles = to.files;

  const imports = importsBetween(db, from.files, toFiles);
  const entries = packageEntryFileIds(db);
  const specifiers = db.prepare("SELECT imported, local FROM import_specifiers WHERE import_id = ?");
  const importDtos: BoundaryImportDto[] = imports.map((row) => {
    const names = (specifiers.all(row.id) as Array<{ imported: string; local: string }>)
      .map((s) => (s.imported === "*" || s.imported === "default" ? s.local : s.imported));
    return {
      fromId: `file:${row.fromId}`, fromPath: row.fromPath, toId: `file:${row.toId}`, toPath: row.toPath, line: row.line,
      names, typeOnly: row.typeOnly === 1,
      bypass: row.typeOnly === 0 && isBypass(row, entries, db),
    };
  });

  const symbols = new Map<number, BoundarySymbolDto>();
  const calls = inBatches([...from.files], (batch) => db.prepare(
    `SELECT t.id, t.name, t.container, t.kind, tf.path, t.start_line AS line,
            COUNT(*) AS calls, COUNT(DISTINCT COALESCE(c.caller_symbol_id, -c.file_id)) AS callers
     FROM call_sites c JOIN symbols t ON t.id = c.target_symbol_id JOIN files tf ON tf.id = t.file_id
     WHERE c.resolution IN ('exact', 'likely') AND c.file_id IN (${batch.map(() => "?").join(",")})
     GROUP BY t.id`,
  ).all(...batch) as Array<{ id: number; name: string; container: string | null; kind: SymbolKind; path: string; line: number; calls: number; callers: number }>);
  for (const row of calls) {
    if (!toFiles.has(fileIdOf(db, row.id))) continue;
    if (to.symbolId !== null && row.id !== to.symbolId) continue;
    const existing = symbols.get(row.id);
    if (existing) {
      existing.calls += row.calls;
      existing.callers += row.callers;
    } else {
      symbols.set(row.id, {
        id: `sym:${row.id}`, name: row.container ? `${row.container}.${row.name}` : row.name, kind: row.kind,
        path: row.path, line: row.line, calls: row.calls, callers: row.callers, importOnly: false,
      });
    }
  }
  // Names that are only imported but not called: types, constants, classes
  const byName = db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.start_line AS line FROM symbols s
     WHERE s.file_id = ? AND s.name = ? AND s.container IS NULL ORDER BY s.exported DESC LIMIT 1`,
  );
  for (const row of importDtos) {
    for (const name of row.names) {
      const hit = byName.get(Number(row.toId.slice(5)), name) as
        | { id: number; name: string; container: string | null; kind: SymbolKind; line: number } | undefined;
      if (!hit || symbols.has(hit.id) || (to.symbolId !== null && hit.id !== to.symbolId)) continue;
      symbols.set(hit.id, { id: `sym:${hit.id}`, name: hit.name, kind: hit.kind, path: row.toPath, line: hit.line, calls: 0, callers: 0, importOnly: true });
    }
  }

  // The request may be sent inside a function, or it may be sent in an anonymous function at the top level of a module or in an object literal. At that time, the caller is recorded on the file.
  const http = (inBatches([...from.files], (batch) => db.prepare(
    `SELECT e.src_kind AS callerKind, COALESCE(s.id, sf.id) AS callerId, COALESCE(s.name, sf.path) AS caller, sf.path AS callerPath,
            e.line, d.id AS routeId, d.name AS route, df.path AS routePath, d.file_id AS routeFile
     FROM edges e
     LEFT JOIN symbols s ON e.src_kind = 'symbol' AND s.id = e.src_id
     JOIN files sf ON sf.id = CASE WHEN e.src_kind = 'file' THEN e.src_id ELSE s.file_id END
     JOIN symbols d ON d.id = e.dst_id JOIN files df ON df.id = d.file_id
     WHERE e.type = 'calls' AND e.call_kind = 'http' AND e.dst_kind = 'symbol'
       AND sf.id IN (${batch.map(() => "?").join(",")})
     ORDER BY sf.path, e.line`,
  ).all(...batch)) as Array<{
    callerKind: "symbol" | "file"; callerId: number; caller: string; callerPath: string; line: number | null;
    routeId: number; route: string; routePath: string; routeFile: number;
  }>)
    .filter((row) => toFiles.has(row.routeFile))
    .map((row) => ({
      callerId: `${row.callerKind === "symbol" ? "sym" : "file"}:${row.callerId}`,
      caller: row.callerKind === "symbol" ? row.caller : (row.callerPath.split("/").at(-1) ?? row.callerPath),
      callerPath: row.callerPath, line: row.line ?? 0,
      routeId: `sym:${row.routeId}`, route: row.route, routePath: row.routePath,
    }));

  const symbolList = [...symbols.values()].sort((a, b) => b.calls - a.calls || Number(a.importOnly) - Number(b.importOnly) || a.name.localeCompare(b.name));
  const direct = importDtos.length > 0 || symbolList.length > 0 || http.length > 0;
  return {
    from: { id: from.id, label: from.label, path: from.path },
    to: { id: to.id, label: to.label, path: to.path },
    imports: importDtos.slice(0, MAX_IMPORTS_LISTED),
    symbols: symbolList,
    http,
    totals: {
      files: new Set(importDtos.map((row) => row.fromId)).size,
      imports: importDtos.length,
      typeOnly: importDtos.filter((row) => row.typeOnly).length,
      bypass: importDtos.filter((row) => row.bypass).length,
      calls: symbolList.reduce((sum, s) => sum + s.calls, 0),
      symbols: symbolList.length,
    },
    path: direct ? null : shortestImportPath(db, from.files, toFiles),
  };
}

function importsBetween(db: Db, fromFiles: ReadonlySet<number>, toFiles: ReadonlySet<number>): ImportRow[] {
  if (fromFiles.size === 0 || toFiles.size === 0) return [];
  return inBatches([...fromFiles], (batch) => db.prepare(
    `SELECT i.id, i.file_id AS fromId, sf.path AS fromPath, sf.package_id AS fromPackage,
            tf.id AS toId, tf.path AS toPath, tf.package_id AS toPackage, i.line, i.is_type_only AS typeOnly, tf.language
     FROM imports i JOIN files sf ON sf.id = i.file_id JOIN files tf ON tf.id = i.target_file_id
     WHERE i.file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as ImportRow[])
    .filter((row) => toFiles.has(row.toId) && row.fromId !== row.toId)
    .sort((a, b) => a.fromPath.localeCompare(b.fromPath) || a.line - b.line);
}

function isBypass(row: ImportRow, entries: ReadonlySet<number>, db: Db): boolean {
  if (row.fromPackage === null || row.toPackage === null || row.fromPackage === row.toPackage) return false;
  if (!NODE_LANGUAGES.has(row.language) || entries.has(row.toId)) return false;
  const pkg = db.prepare("SELECT dir, manager FROM packages WHERE id = ?").get(row.toPackage) as { dir: string; manager: string } | undefined;
  if (!pkg || pkg.dir === "." || row.fromPath.startsWith(`${pkg.dir}/`) || !["pnpm", "npm", "yarn"].includes(pkg.manager)) return false;
  // Only after the other party has declared the entry can we talk about bypassing it.
  return (db.prepare("SELECT id FROM files WHERE package_id = ? AND role = 'source'").all(row.toPackage) as Array<{ id: number }>)
    .some((file) => entries.has(file.id));
}

function fileIdOf(db: Db, symbolId: number): number {
  return (db.prepare("SELECT file_id AS fileId FROM symbols WHERE id = ?").get(symbolId) as { fileId: number } | undefined)?.fileId ?? -1;
}

/** The shortest file-level import chain (including HTTP), from any file in 'from' to any file in 'to' */
function shortestImportPath(db: Db, fromFiles: ReadonlySet<number>, toFiles: ReadonlySet<number>): Array<{ id: string; path: string }> | null {
  if (fromFiles.size === 0 || toFiles.size === 0) return null;
  const adjacency = new Map<number, number[]>();
  for (const edge of db.prepare(
    "SELECT src_id AS src, dst_id AS dst FROM edges WHERE src_kind = 'file' AND dst_kind = 'file' AND type IN ('imports', 'http')",
  ).all() as Array<{ src: number; dst: number }>) {
    const bucket = adjacency.get(edge.src);
    if (bucket) bucket.push(edge.dst); else adjacency.set(edge.src, [edge.dst]);
  }
  const previous = new Map<number, number | null>();
  let frontier = [...fromFiles];
  for (const id of frontier) previous.set(id, null);
  for (let hop = 0; hop < MAX_PATH_HOPS && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const target of adjacency.get(id) ?? []) {
        if (previous.has(target)) continue;
        previous.set(target, id);
        if (toFiles.has(target)) {
          const chain: number[] = [];
          for (let cursor: number | null = target; cursor !== null; cursor = previous.get(cursor) ?? null) chain.unshift(cursor);
          const pathOf = db.prepare("SELECT path FROM files WHERE id = ?");
          return chain.map((fileId) => ({ id: `file:${fileId}`, path: (pathOf.get(fileId) as { path: string }).path }));
        }
        next.push(target);
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Module Business Card
// ---------------------------------------------------------------------------

const API_LISTED = 12;
const LINKS_LISTED = 8;

/**
 * Everything you need to know when treating a package or directory as a black box. The external interface is ranked according to 'how many functions outside the scope call it and how many files import it.'
 * Group who depends on whom / who is depended on by whom according to the other party's package (for cross-package) or directory (for same-package), and include the names that cross the boundary for each group.
 */
export function getModuleCard(db: Db, nodeId: string, confirmed: readonly ConfirmedLayer[] = confirmedLayers(db)): ModuleCardDto | null {
  const scope = resolveScope(db, nodeId);
  if (!scope || scope.kind === "symbol" || scope.kind === "file") return null;
  const inside = scope.files;
  const allSource = db.prepare("SELECT id, path, package_id AS packageId, dir_path AS dir FROM files WHERE role = 'source'").all() as Array<{
    id: number; path: string; packageId: number | null; dir: string;
  }>;
  const fileById = new Map(allSource.map((f) => [f.id, f]));
  const packages = hasPackageGraph(db)
    ? new Map((db.prepare("SELECT id, name, dir FROM packages").all() as Array<{ id: number; name: string; dir: string }>)
      .map((p) => [p.id, p]))
    : new Map<number, { id: number; name: string; dir: string }>();

  const api = moduleApi(db, inside);

  const groupOf = (fileId: number): { id: string; label: string } | null => {
    const file = fileById.get(fileId);
    if (!file) return null;
    const crossPackage = file.packageId !== null && file.packageId !== scope.packageId && (scope.kind !== "package" || file.packageId !== scope.packageId);
    if (crossPackage && packages.size > 1) {
      const pkg = packages.get(file.packageId!);
      if (pkg) return { id: `pkg:${pkg.name}`, label: pkg.name };
    }
    return { id: `dir:${file.dir}`, label: file.dir };
  };

  const links = (direction: "out" | "in"): ModuleLinkDto[] => {
    const rows = inBatches([...inside], (batch) => db.prepare(
      direction === "out"
        ? `SELECT i.id, i.file_id AS self, i.target_file_id AS other, i.is_type_only AS typeOnly FROM imports i
           WHERE i.target_file_id IS NOT NULL AND i.file_id IN (${batch.map(() => "?").join(",")})`
        : `SELECT i.id, i.target_file_id AS self, i.file_id AS other, i.is_type_only AS typeOnly FROM imports i
           WHERE i.target_file_id IN (${batch.map(() => "?").join(",")})`,
    ).all(...batch) as Array<{ id: number; self: number; other: number; typeOnly: number }>);
    const specifiers = db.prepare("SELECT imported, local FROM import_specifiers WHERE import_id = ?");
    const groups = new Map<string, ModuleLinkDto & { nameCounts: Map<string, number> }>();
    for (const row of rows) {
      if (inside.has(row.other) || !fileById.has(row.other)) continue;
      const group = groupOf(row.other);
      if (!group) continue;
      let entry = groups.get(group.id);
      if (!entry) {
        entry = { ...group, imports: 0, names: [], typeOnly: true, http: false, nameCounts: new Map() };
        groups.set(group.id, entry);
      }
      entry.imports++;
      if (row.typeOnly === 0) entry.typeOnly = false;
      for (const spec of specifiers.all(row.id) as Array<{ imported: string; local: string }>) {
        const name = spec.imported === "*" || spec.imported === "default" ? spec.local : spec.imported;
        entry.nameCounts.set(name, (entry.nameCounts.get(name) ?? 0) + 1);
      }
    }
    const httpEdges = inBatches([...inside], (batch) => db.prepare(
      direction === "out"
        ? `SELECT dst_id AS other FROM edges WHERE type = 'http' AND src_kind = 'file' AND dst_kind = 'file' AND src_id IN (${batch.map(() => "?").join(",")})`
        : `SELECT src_id AS other FROM edges WHERE type = 'http' AND src_kind = 'file' AND dst_kind = 'file' AND dst_id IN (${batch.map(() => "?").join(",")})`,
    ).all(...batch) as Array<{ other: number }>);
    for (const edge of httpEdges) {
      if (inside.has(edge.other)) continue;
      const group = groupOf(edge.other);
      if (!group) continue;
      const entry = groups.get(group.id) ?? { ...group, imports: 0, names: [], typeOnly: false, http: true, nameCounts: new Map() };
      entry.http = true;
      entry.typeOnly = false;
      groups.set(group.id, entry);
    }
    return [...groups.values()]
      .map(({ nameCounts, ...link }) => ({
        ...link,
        names: [...nameCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([name]) => name),
      }))
      .sort((a, b) => Number(a.typeOnly) - Number(b.typeOnly) || b.imports - a.imports || a.label.localeCompare(b.label))
      .slice(0, LINKS_LISTED);
  };

  const externals = (inBatches([...inside], (batch) => db.prepare(
    `SELECT external_name AS name, COUNT(DISTINCT file_id) AS files FROM imports
     WHERE external_name IS NOT NULL AND is_type_only = 0 AND file_id IN (${batch.map(() => "?").join(",")})
     GROUP BY external_name`,
  ).all(...batch)) as Array<{ name: string; files: number }>)
    .reduce((acc, row) => acc.set(row.name, (acc.get(row.name) ?? 0) + row.files), new Map<string, number>());

  const io = (inBatches([...inside], (batch) => db.prepare(
    `SELECT r.kind, COUNT(*) AS n FROM io_reach r JOIN symbols s ON s.id = r.symbol_id
     WHERE r.depth = 0 AND s.file_id IN (${batch.map(() => "?").join(",")}) GROUP BY r.kind`,
  ).all(...batch)) as Array<{ kind: IoKind; n: number }>)
    .reduce((acc, row) => acc.set(row.kind, (acc.get(row.kind) ?? 0) + row.n), new Map<IoKind, number>());

  const entries = (inBatches([...inside], (batch) => db.prepare(
    `SELECT id, kind, label, symbol_id AS symbolId FROM entry_points
     WHERE kind != 'test' AND file_id IN (${batch.map(() => "?").join(",")}) ORDER BY reach_symbols DESC`,
  ).all(...batch)) as Array<{ id: number; kind: EntryPointKind; label: string; symbolId: number | null }>)
    .slice(0, 10)
    .map((row) => ({ id: `entry:${row.id}`, kind: row.kind, label: row.label, symbolId: row.symbolId === null ? null : `sym:${row.symbolId}` }));

  const functions = inBatches([...inside], (batch) => db.prepare(
    `SELECT s.id, t.symbol_id IS NOT NULL AS covered FROM symbols s LEFT JOIN test_coverage t ON t.symbol_id = s.id
     WHERE s.kind IN ('function', 'method') AND s.implemented = 1 AND s.file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; covered: number }>);

  return {
    id: scope.id,
    label: scope.label,
    path: scope.path,
    api: api.all.slice(0, API_LISTED),
    apiTotal: api.all.length,
    dependsOn: links("out"),
    usedBy: links("in"),
    externals: [...externals].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, files]) => ({ name, files })),
    io: [...io].sort((a, b) => b[1] - a[1]).map(([kind, functions]) => ({ kind, functions })),
    entries,
    tests: {
      functions: functions.length,
      covered: functions.filter((f) => f.covered === 1).length,
      cases: casesReaching(db, functions.map((f) => f.id)).size,
    },
    history: moduleHistory(db, scope),
    layer: layerOf(db, scope.id, confirmed),
  };
}

/** Symbols called or imported from outside the scope */
function moduleApi(db: Db, inside: ReadonlySet<number>): { all: ModuleApiDto[] } {
  const stats = new Map<number, { callers: Set<string>; files: Set<number> }>();
  const bump = (symbolId: number, caller: string | null, fileId: number) => {
    let entry = stats.get(symbolId);
    if (!entry) {
      entry = { callers: new Set(), files: new Set() };
      stats.set(symbolId, entry);
    }
    if (caller !== null) entry.callers.add(caller);
    entry.files.add(fileId);
  };
  const symbolsInside = new Map<number, { name: string; container: string | null; kind: SymbolKind; path: string; line: number; signature: string | null; fileId: number }>();
  for (const row of inBatches([...inside], (batch) => db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, f.path, s.start_line AS line, s.signature, s.file_id AS fileId
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; name: string; container: string | null; kind: SymbolKind; path: string; line: number; signature: string | null; fileId: number }>)) {
    symbolsInside.set(row.id, row);
  }

  const calls = inBatches([...symbolsInside.keys()], (batch) => db.prepare(
    `SELECT c.target_symbol_id AS target, c.caller_symbol_id AS caller, c.file_id AS fileId FROM call_sites c
     JOIN files f ON f.id = c.file_id
     WHERE f.role = 'source' AND c.resolution IN ('exact', 'likely') AND c.target_symbol_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ target: number; caller: number | null; fileId: number }>);
  for (const call of calls) {
    if (inside.has(call.fileId)) continue;
    bump(call.target, call.caller === null ? `file:${call.fileId}` : `sym:${call.caller}`, call.fileId);
  }

  // Names that are only imported (types, constants, classes) are also part of the interface
  const imported = inBatches([...inside], (batch) => db.prepare(
    `SELECT i.file_id AS fileId, i.target_file_id AS target, sp.imported FROM imports i
     JOIN files f ON f.id = i.file_id JOIN import_specifiers sp ON sp.import_id = i.id
     WHERE f.role = 'source' AND i.target_file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ fileId: number; target: number; imported: string }>);
  const byName = new Map<string, number>();
  for (const [id, symbol] of symbolsInside) {
    if (symbol.container === null) byName.set(`${symbol.fileId}\u0000${symbol.name}`, id);
  }
  for (const row of imported) {
    if (inside.has(row.fileId)) continue;
    const id = byName.get(`${row.target}\u0000${row.imported}`);
    if (id !== undefined) bump(id, null, row.fileId);
  }

  const all = [...stats].map(([id, entry]): ModuleApiDto => {
    const symbol = symbolsInside.get(id)!;
    return {
      id: `sym:${id}`, name: symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name, kind: symbol.kind,
      path: symbol.path, line: symbol.line, signature: symbol.signature, callers: entry.callers.size, files: entry.files.size,
    };
  }).sort((a, b) => b.callers - a.callers || b.files - a.files || a.name.localeCompare(b.name));
  return { all };
}

function moduleHistory(db: Db, scope: NodeScope): ModuleCardDto["history"] {
  const counts = commitCounts(db, scope.files);
  if (!counts) return null;
  const rows = inBatches([...scope.files], (batch) => db.prepare(
    `SELECT f.id, f.path, f.complexity, h.recent FROM files f
     JOIN file_history h ON h.path = f.path WHERE f.id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; path: string; complexity: number; recent: number }>);
  return {
    commits: counts.commits,
    recentCommits: counts.recent,
    aiCommits: counts.ai,
    hottest: rows
      .filter((r) => r.recent > 0)
      .sort((a, b) => b.recent - a.recent || b.complexity - a.complexity)
      .slice(0, 3)
      .map((r) => ({ id: `file:${r.id}`, path: r.path, recentCommits: r.recent, complexity: r.complexity })),
  };
}

function layerOf(db: Db, nodeId: string, confirmed: readonly ConfirmedLayer[]): ModuleCardDto["layer"] {
  const hit = confirmed.find((layer) => layer.members.includes(nodeId));
  if (hit) return { name: hit.name, confirmed: true };
  if (confirmed.length > 0) return null;
  for (const row of db.prepare("SELECT name, members FROM layers ORDER BY ordinal").all() as Array<{ name: string; members: string }>) {
    try {
      if ((JSON.parse(row.members) as string[]).includes(nodeId)) return { name: row.name, confirmed: false };
    } catch {
      continue;
    }
  }
  return null;
}
