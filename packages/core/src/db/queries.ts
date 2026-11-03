import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseName, depthOf, dirOf, isWithin } from "../resolve/path-utils.js";
import type {
  CallGraphOptions,
  Confidence,
  ConfirmedLayer,
  FileDetailDto,
  FileRole,
  FindingDto,
  FindingKind,
  FindingQuery,
  FindingSeverity,
  FindingSummaryDto,
  GraphDto,
  GraphEdgeDto,
  GraphNodeDto,
  ImportKind,
  IndexTotals,
  Language,
  LanguageBreakdown,
  NodeMetrics,
  OverviewDto,
  ParamDto,
  PseudocodeStepDto,
  ReadmeDto,
  RelationDto,
  ScanStats,
  SearchHitDto,
  SourceSliceDto,
  SymbolDetailDto,
  SymbolKind,
  SymbolSummaryDto,
  TreeNodeDto,
  LlmStatusDto,
} from "../types.js";
import { hasPackageGraph } from "./architecture.js";
import { getMeta, getMetaJson, type Db } from "./database.js";
import { fileHistory } from "./file-history.js";
import { groundText } from "./grounding.js";
import { readLlmStatus, semanticLanguage } from "./semantic.js";
import { casesReaching, testCoverageOf } from "./spec.js";
import {
  normalizeSemanticContent,
  parsePseudocodeSteps,
  parsePseudocodeText,
  type SemanticTextFlavor,
} from "./semantic-format.js";

export const EXTERNAL_NODE_ID = "external";

/** The id of the root scope of the repository. Package-level views and top-level directory views are all attached here. */
export const ROOT_SCOPE = "dir:.";

export interface GraphOptions {
  /** Scope node id; defaults to the root of the repository */
  scope?: string | undefined;
  /** Maximum number of nodes, excess nodes are folded into aggregate nodes according to the main metric */
  limit?: number | undefined;
  roles?: FileRole[] | undefined;
  confidence?: Confidence[] | undefined;
  includeExternal?: boolean | undefined;
  /**
   * This node must appear in the results and cannot be collapsed.
   *
   * Use for 'jump to a specific node': if not locked, the target that is accessed from search or the checklist
   * It is often the one with a small size, which goes into 'Other N items' as soon as it is folded, and you can't see it at all in the chart.
   * Navigation is only half the journey.
   */
  keep?: string | undefined;
}

const DEFAULT_ROLES: FileRole[] = ["source"];
const DEFAULT_CONFIDENCE: Confidence[] = ["exact", "likely"];

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function getOverview(db: Db): OverviewDto {
  const lastRun = getMetaJson<ScanStats>(db, "stats", {} as ScanStats);
  const totals = getIndexTotals(db);
  const totalLoc = Math.max(totals.loc, 1);

  const languages: LanguageBreakdown[] = (
    db
      .prepare(
        `SELECT language, COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc
         FROM files WHERE role != 'asset'
         GROUP BY language ORDER BY loc DESC`,
      )
      .all() as Array<{ language: string; files: number; loc: number }>
  ).map((row) => ({
    language: row.language as Language,
    files: row.files,
    loc: row.loc,
    share: row.loc / totalLoc,
  }));

  const multiPackage = hasPackageGraph(db);
  const packages = (
    db
      .prepare(
        `SELECT p.name, p.dir, p.manager,
                COALESCE(SUM(f.loc), 0) AS loc,
                COUNT(f.id) AS files
         FROM packages p
         LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
         GROUP BY p.id
         ORDER BY loc DESC`,
      )
      .all() as Array<{ name: string; dir: string; manager: string; loc: number; files: number }>
  )
    .filter((row) => multiPackage || row.dir === ".")
    .map((row) => ({
      id: `pkg:${row.name}`,
      name: row.name,
      dir: row.dir,
      manager: row.manager as OverviewDto["packages"][number]["manager"],
      loc: row.loc,
      files: row.files,
    }));

  const confirmed = confirmedLayers(db);
  const layers = confirmed.length > 0
    ? confirmed.map((layer) => ({ name: layer.name, description: layer.description ?? "", nodeIds: layer.members }))
    : (db
      .prepare("SELECT name, description, members FROM layers ORDER BY ordinal, id")
      .all() as Array<{ name: string; description: string; members: string }>).map((row) => ({
        name: row.name,
        description: row.description,
        nodeIds: parseStringArray(row.members),
      }));
  const llmStatus = readLlmStatus(db);
  const lock = getMetaJson<{ level: "package" | "directory"; dependencies: number } | null>(db, "lock", null);
  const history = getMetaJson<{ commits: number; aiCommits: number } | null>(db, "history", null);

  return {
    repoName: getMeta(db, "repo_name") ?? "repo",
    repoRoot: getMeta(db, "repo_root") ?? "",
    scannedAt: getMeta(db, "scanned_at") ?? "",
    totals,
    lastScan: {
      durationMs: lastRun.durationMs ?? 0,
      filesParsed: lastRun.filesParsed ?? 0,
      filesReused: lastRun.filesReused ?? 0,
      filesDeleted: lastRun.filesDeleted ?? 0,
      parseErrors: lastRun.parseErrors ?? 0,
    },
    languages,
    packages,
    summary: readSummary(db, "repo", "."),
    summaryUnavailableReason: lastRun.llm?.reason ?? null,
    layers: layers.length > 0 ? layers : null,
    layersConfirmed: confirmed.length > 0,
    lock,
    history: history ? { commits: history.commits, aiCommits: history.aiCommits } : null,
    llm: llmStatus as LlmStatusDto | null,
  };
}

/** Confirmed layering (recorded into the index from .repolens.json during scanning, and also written in when confirmed through the interface) */
export function confirmedLayers(db: Db): ConfirmedLayer[] {
  return getMetaJson<ConfirmedLayer[]>(db, "confirmed_layers", []);
}

/** The total index is always calculated immediately. The numbers saved will only turn into lies after the next incremental scan. */
export function getIndexTotals(db: Db): IndexTotals {
  const one = <T>(sql: string, fallback: T): T => (db.prepare(sql).get() as { v: T }).v ?? fallback;

  // Use confidence instead of target_file_id to determine whether the parsing was successful: package-level in Go
  // import fell on the directory, there is no corresponding file id, but it was parsed out
  const imports = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(confidence = 'external'), 0) AS external,
              COALESCE(SUM(confidence = 'unresolved'), 0) AS unresolved
       FROM imports`,
    )
    .get() as { total: number; external: number; unresolved: number };

  return {
    files: one("SELECT COUNT(*) AS v FROM files WHERE role != 'asset'", 0),
    loc: one("SELECT COALESCE(SUM(loc), 0) AS v FROM files WHERE role != 'asset'", 0),
    sourceFiles: one("SELECT COUNT(*) AS v FROM files WHERE role = 'source'", 0),
    sourceLoc: one("SELECT COALESCE(SUM(loc), 0) AS v FROM files WHERE role = 'source'", 0),
    symbols: one("SELECT COUNT(*) AS v FROM symbols", 0),
    calls: one("SELECT COUNT(*) AS v FROM call_sites", 0),
    imports: imports.total,
    importsResolved: imports.total - imports.external - imports.unresolved,
    importsExternal: imports.external,
    importsUnresolved: imports.unresolved,
    packages: hasPackageGraph(db)
      ? one("SELECT COUNT(*) AS v FROM packages", 0)
      : one("SELECT COUNT(*) AS v FROM packages WHERE dir = '.'", 0),
  };
}

// ---------------------------------------------------------------------------
// Directory Tree
// ---------------------------------------------------------------------------

/**
 * Get the tree under a certain directory.
 *
 * Return only `depth` levels at a time, not the entire tree: the complete tree of a 400,000-line repository has thousands of nodes,
 * And the user always only unfolds one of the paths.
 */
export function getTree(db: Db, path = ".", depth = 1, roles = DEFAULT_ROLES): TreeNodeDto {
  const self = treeNodeForDir(db, path);
  self.children = depth > 0 ? treeChildren(db, path, depth - 1, roles) : null;
  return self;
}

function treeNodeForDir(db: Db, path: string): TreeNodeDto {
  if (path === ".") {
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(loc), 0) AS loc, COUNT(*) AS files, COALESCE(SUM(complexity), 0) AS complexity
         FROM files WHERE role = 'source'`,
      )
      .get() as { loc: number; files: number; complexity: number };
    const symbols = (db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    return {
      id: "dir:.",
      name: getMeta(db, "repo_name") ?? "repo",
      path: ".",
      kind: "directory",
      loc: totals.loc,
      files: totals.files,
      symbols,
      complexity: totals.complexity,
      heat: 1,
      hasChildren: true,
      children: null,
    };
  }

  const row = db
    .prepare(
      "SELECT path, name, loc, file_count AS files, symbol_count AS symbols, complexity FROM directories WHERE path = ?",
    )
    .get(path) as
    | { path: string; name: string; loc: number; files: number; symbols: number; complexity: number }
    | undefined;

  if (!row) {
    return {
      id: `dir:${path}`,
      name: baseName(path),
      path,
      kind: "directory",
      loc: 0,
      files: 0,
      symbols: 0,
      complexity: 0,
      heat: 0,
      hasChildren: false,
      children: null,
    };
  }

  return {
    id: `dir:${row.path}`,
    name: row.name,
    path: row.path,
    kind: "directory",
    loc: row.loc,
    files: row.files,
    symbols: row.symbols,
    complexity: row.complexity,
    heat: 0,
    hasChildren: true,
    children: null,
  };
}

function treeChildren(db: Db, parent: string, remainingDepth: number, roles: FileRole[]): TreeNodeDto[] {
  const dirRows = visibleDirectoryRows(
    db,
    "d.parent_path IS ?",
    [parent === "." ? null : parent],
    roles,
  ).sort((a, b) => b.loc - a.loc);

  // The direct subdirectories of the root directory have parent_path as null in the directories table and need to be handled separately.
  const rootDirs =
    parent === "."
      ? visibleDirectoryRows(db, "d.depth = 1", [], roles).sort((a, b) => b.loc - a.loc)
      : [];

  const dirs = parent === "." ? rootDirs : dirRows;

  const placeholders = roles.map(() => "?").join(",");
  const fileRows = db
    .prepare(
      `SELECT id, path, name, language, role, loc, complexity,
              (SELECT COUNT(*) FROM symbols s WHERE s.file_id = files.id) AS symbols
       FROM files WHERE dir_path = ? AND role IN (${placeholders})
       ORDER BY loc DESC`,
    )
    .all(parent, ...roles) as Array<{
    id: number;
    path: string;
    name: string;
    language: string;
    role: string;
    loc: number;
    complexity: number;
    symbols: number;
  }>;

  const maxLoc = Math.max(
    1,
    ...dirs.map((d) => d.loc),
    ...fileRows.map((f) => f.loc),
  );

  const children: TreeNodeDto[] = [];

  for (const dir of dirs) {
    children.push({
      id: `dir:${dir.path}`,
      name: dir.name,
      path: dir.path,
      kind: "directory",
      loc: dir.loc,
      files: dir.files,
      symbols: dir.symbols,
      complexity: dir.complexity,
      heat: dir.loc / maxLoc,
      hasChildren: true,
      children: remainingDepth > 0 ? treeChildren(db, dir.path, remainingDepth - 1, roles) : null,
    });
  }

  for (const file of fileRows) {
    children.push({
      id: `file:${file.id}`,
      name: file.name,
      path: file.path,
      kind: "file",
      language: file.language as Language,
      role: file.role as FileRole,
      loc: file.loc,
      files: 1,
      symbols: file.symbols,
      complexity: file.complexity,
      heat: file.loc / maxLoc,
      hasChildren: file.symbols > 0,
      children: null,
    });
  }

  return children;
}

// ---------------------------------------------------------------------------
// Picture
// ---------------------------------------------------------------------------

/**
 * Construct a one-layer graph under a certain scope.
 *
 * The meaning of 'one layer' is: only return the direct child members of that scope as nodes, and the dependencies between the members.
 * Aggregated from the lower-level edges. This is the data foundation for progressive drilling in docs/INTERACTION.md——
 * The front end always only holds the current layer.
 */
export function getScopeGraph(db: Db, options: GraphOptions = {}): GraphDto {
  const scope = options.scope ?? ROOT_SCOPE;
  const limit = options.limit ?? 30;
  const roles = options.roles ?? DEFAULT_ROLES;
  const includeExternal = options.includeExternal ?? false;
  const keep = options.keep;

  if (scope === ROOT_SCOPE) {
    const packageGraph = tryPackageGraph(db, limit, includeExternal, keep);
    if (packageGraph) return packageGraph;
  }

  if (scope.startsWith("pkg:")) {
    const pkgDir = packageDir(db, scope.slice(4));
    return pkgDir === null
      ? emptyGraph()
      : directoryScopeGraph(db, pkgDir, limit, roles, includeExternal, keep);
  }

  if (scope.startsWith("dir:")) {
    return directoryScopeGraph(db, scope.slice(4), limit, roles, includeExternal, keep);
  }

  if (scope.startsWith("file:")) {
    return fileSymbolGraph(db, Number(scope.slice(5)), limit, keep);
  }

  // Unrecognized scopes will all trigger errors. Returning an empty graph will make 'clicking with no response' look like a layout issue.
  // And the real reason is that the scope id was misspelled somewhere——this pitfall has been encountered once before.
  throw new Error(`未知的 scope：${scope}（应为 pkg: / dir: / file: 前缀）`);
}

/** When the number of packages < 2 or the packages do not cover the main source code of the repository, the package-level view is not representative and degenerates into a top-level directory view. */
function tryPackageGraph(
  db: Db,
  limit: number,
  includeExternal: boolean,
  keep?: string | undefined,
): GraphDto | null {
  if (!hasPackageGraph(db)) return null;

  const rows = db
    .prepare(
      `SELECT p.name, p.dir, p.manager,
              COALESCE(SUM(f.loc), 0) AS loc,
              COUNT(f.id) AS files,
              COALESCE(SUM(f.complexity), 0) AS complexity
       FROM packages p
       LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
       GROUP BY p.id ORDER BY p.dir, p.name`,
    )
    .all() as Array<{
    name: string;
    dir: string;
    manager: string;
    loc: number;
    files: number;
    complexity: number;
  }>;

  const meaningful = rows.filter((r) => r.files > 0);
  if (meaningful.length < 2) return null;

  const symbolCounts = new Map(
    (
      db
        .prepare(
          `SELECT p.name AS name, COUNT(s.id) AS n
           FROM packages p
           JOIN files f ON f.package_id = p.id
           JOIN symbols s ON s.file_id = f.id
           GROUP BY p.id`,
        )
        .all() as Array<{ name: string; n: number }>
    ).map((r) => [r.name, r.n]),
  );

  const nodes: GraphNodeDto[] = meaningful.map((row) => ({
    id: `pkg:${row.name}`,
    kind: "package",
    label: row.name,
    path: row.dir,
    metrics: {
      loc: row.loc,
      files: row.files,
      symbols: symbolCounts.get(row.name) ?? 0,
      complexity: row.complexity,
      inDegree: 0,
      outDegree: 0,
    },
    childCount: row.files,
    expandable: row.files > 0,
  }));

  const edgeRows = db
    .prepare(
      `SELECT src, dst, type, confidence, count FROM rollup_edges
       WHERE level = 'package' AND type IN ('imports', 'references', 'http')`,
    )
    .all() as Array<{ src: string; dst: string; type: string; confidence: string; count: number }>;

  const merged = new Map<string, GraphEdgeDto>();
  for (const row of edgeRows) {
    mergeDependencyEdge(merged, `pkg:${row.src}`, `pkg:${row.dst}`, row.type, row.confidence as Confidence, row.count);
  }
  const edges = [...merged.values()];

  // scopeKey must be the actual scope ID to which this diagram is mounted: the frontend removes the 'agg:' prefix from the aggregation node
  // After stripping it, directly request the parent scope. Writing it as "pkg" will request a non-existent scope.
  // It manifests as the 'Other N items' in the root view not responding when clicked. The package-level graph service is exactly dir:.
  return finalizeGraph(db, nodes, edges, limit, includeExternal, ROOT_SCOPE, keep);
}

function directoryScopeGraph(
  db: Db,
  scopeDir: string,
  limit: number,
  roles: FileRole[],
  includeExternal: boolean,
  keep?: string | undefined,
): GraphDto {
  const childDirs = visibleDirectoryRows(
    db,
    scopeDir === "." ? "d.depth = 1" : "d.parent_path = ?",
    scopeDir === "." ? [] : [scopeDir],
    roles,
  ).sort((a, b) => a.path.localeCompare(b.path));

  const placeholders = roles.map(() => "?").join(",");
  const looseFiles = db
    .prepare(
      `SELECT id, path, name, language, role, loc, complexity,
              (SELECT COUNT(*) FROM symbols s WHERE s.file_id = files.id) AS symbols
       FROM files WHERE dir_path = ? AND role IN (${placeholders}) ORDER BY path`,
    )
    .all(scopeDir, ...roles) as Array<{
    id: number;
    path: string;
    name: string;
    language: string;
    role: string;
    loc: number;
    complexity: number;
    symbols: number;
  }>;

  const nodes: GraphNodeDto[] = [];
  /** Base directory path → Grouping mapping of current node id */
  const groupOf = new Map<string, string>();

  for (const dir of childDirs) {
    const id = `dir:${dir.path}`;
    nodes.push({
      id,
      kind: "directory",
      label: dir.name,
      path: dir.path,
      metrics: {
        loc: dir.loc,
        files: dir.files,
        symbols: dir.symbols,
        complexity: dir.complexity,
        inDegree: 0,
        outDegree: 0,
      },
      childCount: dir.files,
      expandable: true,
    });
    groupOf.set(dir.path, id);
  }

  for (const file of looseFiles) {
    const id = `file:${file.id}`;
    nodes.push({
      id,
      kind: "file",
      label: file.name,
      path: file.path,
      language: file.language as Language,
      role: file.role as FileRole,
      metrics: {
        loc: file.loc,
        files: 1,
        symbols: file.symbols,
        complexity: file.complexity,
        inDegree: 0,
        outDegree: 0,
      },
      childCount: file.symbols,
      expandable: file.symbols > 0,
    });
  }

  // The endpoints of the directory-level rollup edges are the direct parent directories of the files, which need to be merged upward to this level node
  const rollups = db
    .prepare(
      `SELECT src, dst, type, confidence, count FROM rollup_edges
       WHERE level = 'directory' AND type IN ('imports', 'references', 'http')`,
    )
    .all() as Array<{ src: string; dst: string; type: string; confidence: string; count: number }>;

  const fileNodeByDir = new Map<string, string>();
  for (const file of looseFiles) fileNodeByDir.set(file.path, `file:${file.id}`);

  const resolveGroup = (dirPath: string): string | null => {
    if (!isWithin(scopeDir, dirPath)) return null;
    if (dirPath === scopeDir) return null; // Files directly attached under the scope are processed at the file level.
    const direct = groupOf.get(dirPath);
    if (direct) return direct;
    // Find the nearest ancestor at the current level upwards
    let cursor = dirPath;
    while (cursor !== "." && cursor !== scopeDir) {
      const hit = groupOf.get(cursor);
      if (hit) return hit;
      cursor = dirOf(cursor);
    }
    return null;
  };

  const aggregated = new Map<string, GraphEdgeDto>();

  for (const row of rollups) {
    const source = resolveGroup(row.src);
    const target = resolveGroup(row.dst);
    if (source === null || target === null) continue;
    mergeDependencyEdge(aggregated, source, target, row.type, row.confidence as Confidence, row.count);
  }

  // Edges between bulk files under the scope should be taken directly from the file-level edges table.
  if (looseFiles.length > 0) {
    const ids = looseFiles.map((f) => f.id);
    const inClause = ids.map(() => "?").join(",");
    const fileEdges = db
      .prepare(
        `SELECT sf.path AS srcPath, tf.path AS dstPath, e.type, e.confidence, COUNT(*) AS count
         FROM edges e
         JOIN files sf ON sf.id = e.src_id
         JOIN files tf ON tf.id = e.dst_id
         WHERE e.type IN ('imports', 'references', 'http') AND e.src_kind = 'file' AND e.dst_kind = 'file'
           AND (e.src_id IN (${inClause}) OR e.dst_id IN (${inClause}))
         GROUP BY sf.path, tf.path, e.type, e.confidence`,
      )
      .all(...ids, ...ids) as Array<{
      srcPath: string;
      dstPath: string;
      type: string;
      confidence: string;
      count: number;
    }>;

    for (const row of fileEdges) {
      const source = fileNodeByDir.get(row.srcPath) ?? resolveGroup(dirOf(row.srcPath));
      const target = fileNodeByDir.get(row.dstPath) ?? resolveGroup(dirOf(row.dstPath));
      if (!source || !target) continue;
      mergeDependencyEdge(aggregated, source, target, row.type, row.confidence as Confidence, row.count);
    }
  }

  return finalizeGraph(
    db,
    nodes,
    [...aggregated.values()],
    limit,
    includeExternal,
    `dir:${scopeDir}`,
    keep,
  );
}

/**
 * The runtime import and pure type references between the same pair of nodes are merged into a single edge. As long as there is one runtime
 * import, this edge is imports; only when it's all `import type` is it references, and the interface draws it as a faint line.
 * HTTP requests are another type of dependency (inferred, cross-process), forming edges on their own, not parallel with import.
 */
function mergeDependencyEdge(
  store: Map<string, GraphEdgeDto>,
  source: string,
  target: string,
  type: string,
  confidence: Confidence,
  count: number,
): void {
  if (source === target) return;
  const edgeType = type === "http" ? "http" : type === "references" ? "references" : "imports";
  const key = edgeType === "http" ? `${source}->${target}:http` : `${source}->${target}`;
  const existing = store.get(key);
  if (existing) {
    existing.count += count;
    existing.weight += count;
    if (edgeType === "imports") existing.type = "imports";
    return;
  }
  store.set(key, { id: key, source, target, type: edgeType, confidence, weight: count, count });
}

interface VisibleDirectoryRow {
  path: string;
  name: string;
  loc: number;
  files: number;
  symbols: number;
  complexity: number;
}

/**
 * Filter the directory according to currently visible roles, and calculate the metrics of these files on site.
 *
 * The directories table stores the summary values for all roles, querying it directly will return only those containing config
 * `.cursor/` leaves an empty directory shell in the default source view.
 */
function visibleDirectoryRows(
  db: Db,
  directoryPredicate: string,
  predicateArgs: unknown[],
  roles: FileRole[],
): VisibleDirectoryRow[] {
  if (roles.length === 0) return [];
  const placeholders = roles.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT d.path, d.name,
              COALESCE(SUM(f.loc), 0) AS loc,
              COUNT(f.id) AS files,
              COALESCE(SUM(f.complexity), 0) AS complexity,
              COALESCE(SUM((SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id)), 0) AS symbols
       FROM directories d
       JOIN files f
         ON substr(f.path, 1, length(d.path) + 1) = d.path || '/'
        AND f.role IN (${placeholders})
       WHERE ${directoryPredicate}
       GROUP BY d.id, d.path, d.name`,
    )
    .all(...roles, ...predicateArgs) as VisibleDirectoryRow[];
}

/** Symbol view in the file: symbols in the file + the call edges between them. */
function fileSymbolGraph(
  db: Db,
  fileId: number,
  limit: number,
  keep?: string | undefined,
): GraphDto {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, s.exported, s.complexity,
              s.start_line AS startLine, s.end_line AS endLine, f.path, f.language
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.file_id = ?
       ORDER BY s.start_line`,
    )
    .all(fileId) as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    exported: number;
    complexity: number;
    startLine: number;
    endLine: number;
    path: string;
    language: string;
  }>;

  const nodes: GraphNodeDto[] = rows.map((row) => ({
    id: `sym:${row.id}`,
    kind: "symbol",
    label: row.container !== null ? `${row.container}.${row.name}` : row.name,
    path: row.path,
    language: row.language as Language,
    symbolKind: row.kind as SymbolKind,
    metrics: {
      loc: row.endLine - row.startLine + 1,
      files: 0,
      symbols: 1,
      complexity: row.complexity,
      inDegree: 0,
      outDegree: 0,
    },
    childCount: 0,
    expandable: false,
  }));

  // Only draw the calls within the file. Cross-file targets are not on this diagram; forcing it will result in a mess.
  // Overhanging edges pointing outside the canvas; they can be seen in the 'caller/called' section of the symbol details.
  const inFile = new Set(rows.map((r) => r.id));
  const edges: GraphEdgeDto[] = (
    db
      .prepare(
        `SELECT src_id AS src, dst_id AS dst, confidence, weight
         FROM edges
         WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
           AND src_id IN (SELECT id FROM symbols WHERE file_id = ?)`,
      )
      .all(fileId) as Array<{ src: number; dst: number; confidence: string; weight: number }>
  )
    .filter((row) => inFile.has(row.dst) && row.src !== row.dst)
    .map((row) => ({
      id: `sym:${row.src}->sym:${row.dst}`,
      source: `sym:${row.src}`,
      target: `sym:${row.dst}`,
      type: "calls" as const,
      confidence: row.confidence as Confidence,
      weight: row.weight,
      count: row.weight,
    }));

  return finalizeGraph(db, nodes, edges, limit, false, `file:${fileId}`, keep);
}

/**
 * A call graph centered on a symbol, expanding several hops upstream and downstream.
 *
 * This is the entry point for 'understanding how a function is used throughout the entire repository,' which is different from drilling down by directory.
 * Orthogonal browsing paths: the directory answers 'what is there,' while this answers 'who calls it, and who does it call'.
 *
 * Breadth-first and limited per level. The branching factor of the call graph can reach triple digits on hotspot functions.
 * (There are 134 callers of TUI.requestRender in pi), unlimited two-hop expansion
 * It will directly pull out tens of thousands of nodes.
 */
export function getCallGraph(db: Db, options: CallGraphOptions): GraphDto {
  const depth = Math.min(Math.max(options.depth ?? 1, 1), 4);
  const perLevel = Math.min(Math.max(options.limit ?? 12, 1), 200);
  const direction = options.direction ?? "both";
  const confidence = options.confidence ?? ["exact", "likely"];

  const confList = confidence.map(() => "?").join(",");
  const step = {
    callees: db.prepare(
      `SELECT dst_id AS next, confidence, weight FROM edges
       WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
         AND src_id = ? AND confidence IN (${confList})
       ORDER BY weight DESC LIMIT ?`,
    ),
    callers: db.prepare(
      `SELECT src_id AS next, confidence, weight FROM edges
       WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
         AND dst_id = ? AND confidence IN (${confList})
       ORDER BY weight DESC LIMIT ?`,
    ),
  };

  const seen = new Set<number>([options.symbolId]);
  const edges = new Map<string, GraphEdgeDto>();
  let frontier = [options.symbolId];

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const dir of ["callees", "callers"] as const) {
        if (direction !== "both" && direction !== dir) continue;
        const rows = step[dir].all(id, ...confidence, perLevel) as Array<{
          next: number;
          confidence: string;
          weight: number;
        }>;
        for (const row of rows) {
          const [src, dst] = dir === "callees" ? [id, row.next] : [row.next, id];
          const key = `${src}->${dst}`;
          if (!edges.has(key)) {
            edges.set(key, {
              id: `sym:${src}->sym:${dst}`,
              source: `sym:${src}`,
              target: `sym:${dst}`,
              type: "calls",
              confidence: row.confidence as Confidence,
              weight: row.weight,
              count: row.weight,
            });
          }
          if (!seen.has(row.next)) {
            seen.add(row.next);
            next.push(row.next);
          }
        }
      }
    }
    frontier = next;
  }

  const nodes = symbolNodes(db, [...seen], options.symbolId);
  attachSemantics(db, nodes);
  attachFindings(db, nodes);
  // The finalizeGraph folding does not happen here: if the central node is folded into 'Other N items'
  // The entire image has no anchor points, and each layer's limit has already kept the scale under control.
  const normalizedEdges = normalizeEdges(nodes, [...edges.values()]);
  attachDetailRelationCounts(db, nodes);
  return {
    nodes,
    edges: normalizedEdges,
    truncated: omittedAtCenter(db, options.symbolId, direction, confidence, perLevel),
  };
}

/**
 * How many edges were cut off at this layer of the central node?
 *
 * Only calculating the central layer: the number of neighbors in the hotspot function is the only place that can cause a misjudgment (in pi
 * TUI.requestRender has 127 callers (12 shown in the diagram), outer truncation
 * Visually, it already appears as 'this chain has reached the end.' If it’s not reported, it’s just one drawing.
 * A diagram with 12 callers will be treated as all callers.
 */
function omittedAtCenter(
  db: Db,
  symbolId: number,
  direction: "callers" | "callees" | "both",
  confidence: readonly Confidence[],
  perLevel: number,
): number {
  const confList = confidence.map(() => "?").join(",");
  const count = (column: "src_id" | "dst_id") =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
           WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
             AND ${column} = ? AND confidence IN (${confList})`,
        )
        .get(symbolId, ...confidence) as { n: number }
    ).n;

  let omitted = 0;
  if (direction !== "callers") omitted += Math.max(0, count("src_id") - perLevel);
  if (direction !== "callees") omitted += Math.max(0, count("dst_id") - perLevel);
  return omitted;
}

function symbolNodes(db: Db, ids: readonly number[], focusId: number): GraphNodeDto[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, s.complexity,
              s.start_line AS startLine, s.end_line AS endLine,
              f.path, f.language, f.role
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.id IN (${placeholders}) ORDER BY f.path, s.start_line, s.id`,
    )
    .all(...ids) as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    complexity: number;
    startLine: number;
    endLine: number;
    path: string;
    language: string;
    role: string;
  }>;

  return rows.map((row) => ({
    id: `sym:${row.id}`,
    kind: "symbol" as const,
    label: row.container !== null ? `${row.container}.${row.name}` : row.name,
    path: row.path,
    language: row.language as Language,
    role: row.role as FileRole,
    symbolKind: row.kind as SymbolKind,
    metrics: {
      loc: row.endLine - row.startLine + 1,
      files: 0,
      symbols: 1,
      complexity: row.complexity,
      inDegree: 0,
      outDegree: 0,
    },
    childCount: 0,
    expandable: false,
    // The central node must be recognizable on the interface, otherwise after expanding two hops, the starting point will be lost.
    focus: row.id === focusId,
  }));
}

/**
 * Finishing: Fold excess nodes according to the main index, optionally attach external aggregation nodes, and backfill degrees.
 *
 * Folding is the fallback for the 'delete' strategy—no matter how large the data is, the number of nodes in the default view will not exceed the limit.
 */
function finalizeGraph(
  db: Db,
  nodes: GraphNodeDto[],
  edges: GraphEdgeDto[],
  limit: number,
  includeExternal: boolean,
  scopeKey: string,
  keep?: string | undefined,
): GraphDto {
  let finalNodes = nodes;
  let finalEdges = edges;
  let truncated = 0;

  // Both the summary and the physical examination subscript need to be attached before folding, and the aggregate node itself does not pretend to have semantics.
  attachSemantics(db, nodes);
  attachFindings(db, nodes);

  if (nodes.length > limit) {
    const sorted = [...nodes].sort((a, b) => b.metrics.loc - a.metrics.loc || a.id.localeCompare(b.id));
    // Move the locked nodes to the front, so they will definitely fall within the reserved area.
    if (keep !== undefined) {
      const at = sorted.findIndex((n) => n.id === keep);
      if (at > 0) sorted.unshift(...sorted.splice(at, 1));
    }
    const kept = sorted.slice(0, limit - 1);
    const folded = sorted.slice(limit - 1);
    truncated = folded.length;

    const aggId = `agg:${scopeKey}`;
    const foldedIds = new Set(folded.map((n) => n.id));
    const aggNode: GraphNodeDto = {
      id: aggId,
      kind: "aggregate",
      label: `其他 ${folded.length} 项`,
      metrics: {
        loc: folded.reduce((s, n) => s + n.metrics.loc, 0),
        files: folded.reduce((s, n) => s + n.metrics.files, 0),
        symbols: folded.reduce((s, n) => s + n.metrics.symbols, 0),
        complexity: folded.reduce((s, n) => s + n.metrics.complexity, 0),
        inDegree: 0,
        outDegree: 0,
      },
      childCount: folded.length,
      expandable: true,
      aggregatedIds: folded.map((n) => n.id),
    };

    finalNodes = [...kept, aggNode];

    const remapped = new Map<string, GraphEdgeDto>();
    for (const edge of edges) {
      const source = foldedIds.has(edge.source) ? aggId : edge.source;
      const target = foldedIds.has(edge.target) ? aggId : edge.target;
      if (source === target) continue;
      const key = edge.type === "http" ? `${source}->${target}:http` : `${source}->${target}`;
      const existing = remapped.get(key);
      if (existing) {
        existing.count += edge.count;
        existing.weight += edge.weight;
        if (edge.type === "imports") existing.type = "imports";
        continue;
      }
      remapped.set(key, { ...edge, id: key, source, target });
    }
    finalEdges = [...remapped.values()];
  }

  if (includeExternal) {
    const externalEdges = collectExternalEdges(db, finalNodes);
    if (externalEdges.length > 0) {
      finalNodes = [...finalNodes, externalNode(externalEdges)];
      finalEdges = [...finalEdges, ...externalEdges];
    }
  }

  const nodeIds = new Set(finalNodes.map((n) => n.id));
  finalEdges = finalEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  const normalizedEdges = normalizeEdges(finalNodes, finalEdges);
  attachDetailRelationCounts(db, finalNodes);
  return { nodes: finalNodes, edges: normalizedEdges, truncated };
}

/**
 * Backfill the degree and normalize the weight to 0..1.
 *
 * Normalization must be done on the server side, because the front end only gets a single subgraph and cannot see the global maximum.
 * And the edge width is directly calculated using weight (1 + w * 2.4); missing this step will cause an edge with count=49
 * Render as a color block 118 pixels wide.
 */
function normalizeEdges(nodes: readonly GraphNodeDto[], edges: GraphEdgeDto[]): GraphEdgeDto[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const src = byId.get(edge.source);
    const dst = byId.get(edge.target);
    if (src) src.metrics.outDegree++;
    if (dst) dst.metrics.inDegree++;
  }

  const maxWeight = Math.max(1, ...edges.map((e) => e.weight));
  for (const edge of edges) edge.weight = edge.weight / maxWeight;
  return edges.sort((a, b) =>
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id),
  );
}

/**
 * The files and symbol cards show the complete relationship statistics of the objects themselves, not the number of edges currently visible on the canvas.
 *
 * For example, a file has 5 import statements, but two of them point to the same file, and another one goes outside the current [directory].
 * When listing the directory, the local graph will only draw 3 target nodes. If you directly use the graph's degree, the card shows 3,
 * Clicking to view details shows 5. Here, after completing the edge layout statistics, the leaf nodes are overwritten to make the two positions consistent.
 * Packages, directories, and aggregate nodes still retain the number of aggregate edges of the current layer, because they do not have separate detailed relationship tables.
 */
function attachDetailRelationCounts(db: Db, nodes: readonly GraphNodeDto[]): void {
  const fileIds = nodes
    .filter((node) => node.kind === "file")
    .map((node) => Number(node.id.slice("file:".length)))
    .filter(Number.isInteger);
  const symbolIds = nodes
    .filter((node) => node.kind === "symbol")
    .map((node) => Number(node.id.slice("sym:".length)))
    .filter(Number.isInteger);

  const fileOutgoing = groupedCounts(
    db, fileIds,
    "SELECT file_id AS id, COUNT(*) AS n FROM imports WHERE file_id IN",
    "GROUP BY file_id",
  );
  const fileIncoming = groupedCounts(
    db, fileIds,
    `SELECT dst_id AS id, COUNT(DISTINCT src_id) AS n FROM edges
     WHERE type IN ('imports', 'references') AND src_kind = 'file' AND dst_kind = 'file' AND dst_id IN`,
    "GROUP BY dst_id",
  );
  const symbolOutgoing = groupedCounts(
    db, symbolIds,
    `SELECT src_id AS id, COUNT(*) AS n FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND src_id IN`,
    "GROUP BY src_id",
  );
  const symbolIncoming = groupedCounts(
    db, symbolIds,
    `SELECT dst_id AS id, COUNT(*) AS n FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND dst_id IN`,
    "GROUP BY dst_id",
  );

  for (const node of nodes) {
    if (node.kind === "file") {
      const id = Number(node.id.slice("file:".length));
      node.metrics.outDegree = fileOutgoing.get(id) ?? 0;
      node.metrics.inDegree = fileIncoming.get(id) ?? 0;
    } else if (node.kind === "symbol") {
      const id = Number(node.id.slice("sym:".length));
      // The detailed relationship list currently returns up to 200 items at most, and the numbers follow the same limit.
      node.metrics.outDegree = Math.min(symbolOutgoing.get(id) ?? 0, 200);
      node.metrics.inDegree = Math.min(symbolIncoming.get(id) ?? 0, 200);
    }
  }
}

/** The default parameter limit of SQLite varies depending on the build, and batch queries help avoid large call graph overflows. */
function groupedCounts(
  db: Db,
  ids: readonly number[],
  sqlBeforeIn: string,
  sqlAfterIn: string,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(`${sqlBeforeIn} (${placeholders}) ${sqlAfterIn}`)
      .all(...batch) as Array<{ id: number; n: number }>;
    for (const row of rows) counts.set(row.id, row.n);
  }
  return counts;
}

function collectExternalEdges(db: Db, nodes: readonly GraphNodeDto[]): GraphEdgeDto[] {
  const scopes = nodes
    .filter((n) => n.kind === "directory" || n.kind === "package" || n.kind === "file")
    .map((n) => ({ id: n.id, path: n.path ?? "" }))
    .filter((n) => n.path.length > 0);
  if (scopes.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT f.path AS path, COUNT(*) AS count
       FROM edges e JOIN files f ON f.id = e.src_id
       WHERE e.dst_kind = 'external' AND e.src_kind = 'file'
       GROUP BY f.path`,
    )
    .all() as Array<{ path: string; count: number }>;

  const totals = new Map<string, number>();
  for (const row of rows) {
    // Longest prefix match, assign the external dependency count to the most specific local node
    let best: { id: string; len: number } | null = null;
    for (const scope of scopes) {
      if (!isWithin(scope.path, row.path)) continue;
      const len = scope.path.length;
      if (!best || len > best.len) best = { id: scope.id, len };
    }
    if (!best) continue;
    totals.set(best.id, (totals.get(best.id) ?? 0) + row.count);
  }

  return [...totals.entries()].map(([source, count]) => ({
    id: `${source}->external`,
    source,
    target: EXTERNAL_NODE_ID,
    type: "imports" as const,
    confidence: "external" as const,
    weight: count,
    count,
  }));
}

function externalNode(edges: readonly GraphEdgeDto[]): GraphNodeDto {
  const total = edges.reduce((s, e) => s + e.count, 0);
  return {
    id: EXTERNAL_NODE_ID,
    kind: "external",
    label: `外部依赖 (${total})`,
    metrics: { loc: 0, files: 0, symbols: 0, complexity: 0, inDegree: 0, outDegree: 0 },
    childCount: 0,
    expandable: false,
  };
}

function emptyGraph(): GraphDto {
  return { nodes: [], edges: [], truncated: 0 };
}

function packageDir(db: Db, name: string): string | null {
  const row = db.prepare("SELECT dir FROM packages WHERE name = ?").get(name) as
    | { dir: string }
    | undefined;
  return row?.dir ?? null;
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/** Only read the original source code when repoRoot is given, to determine whether the names mentioned in the AI summary are made up. */
export function getFileDetail(db: Db, fileId: number, repoRoot?: string): FileDetailDto | null {
  const file = db
    .prepare(
      `SELECT f.id, f.path, f.language, f.role, f.loc, f.bytes, f.hash, f.parse_error AS parseError,
              p.name AS packageName, p.dir AS packageDir
       FROM files f LEFT JOIN packages p ON p.id = f.package_id
       WHERE f.id = ?`,
    )
    .get(fileId) as
    | {
        id: number;
        path: string;
        language: string;
        role: string;
        loc: number;
        bytes: number;
        hash: string;
        parseError: string | null;
        packageName: string | null;
        packageDir: string | null;
      }
    | undefined;

  if (!file) return null;

  const symbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, s.exported, s.signature,
              s.start_line AS startLine, s.end_line AS endLine, s.complexity, s.implemented,
              (SELECT COUNT(*) FROM edges e WHERE e.type = 'calls' AND e.dst_kind = 'symbol' AND e.dst_id = s.id) AS callerCount,
              (SELECT COUNT(*) FROM edges e WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.src_id = s.id) AS calleeCount
       FROM symbols s WHERE s.file_id = ? ORDER BY s.start_line`,
    )
    .all(fileId) as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    exported: number;
    signature: string | null;
    startLine: number;
    endLine: number;
    complexity: number;
    implemented: number;
    callerCount: number;
    calleeCount: number;
  }>;

  const imports = db
    .prepare(
      `SELECT i.id, i.raw_source AS rawSource, i.kind, i.confidence, tf.path AS targetPath, i.line
       FROM imports i LEFT JOIN files tf ON tf.id = i.target_file_id
       WHERE i.file_id = ? ORDER BY i.line`,
    )
    .all(fileId) as Array<{
    id: number;
    rawSource: string;
    kind: string;
    confidence: string;
    targetPath: string | null;
    line: number;
  }>;

  const specStmt = db.prepare("SELECT local FROM import_specifiers WHERE import_id = ?");
  const summary = readSummary(db, "file", file.path, "summary-v2", file.hash);

  return {
    id: `file:${file.id}`,
    path: file.path,
    language: file.language as Language,
    role: file.role as FileRole,
    loc: file.loc,
    bytes: file.bytes,
    packageName: file.packageName,
    parseError: file.parseError,
    symbols: symbols.map(
      (s): SymbolSummaryDto => ({
        id: `sym:${s.id}`,
        name: s.name,
        kind: s.kind as SymbolKind,
        container: s.container,
        exported: s.exported === 1,
        signature: s.signature,
        startLine: s.startLine,
        endLine: s.endLine,
        loc: s.endLine - s.startLine + 1,
        complexity: s.complexity,
        callerCount: s.callerCount,
        calleeCount: s.calleeCount,
      }),
    ),
    imports: imports.map((imp) => ({
      source: imp.rawSource,
      kind: imp.kind as ImportKind,
      confidence: imp.confidence as Confidence,
      targetPath: imp.targetPath,
      specifiers: (specStmt.all(imp.id) as Array<{ local: string }>).map((s) => s.local),
      line: imp.line,
    })),
    importedBy: (
      db
        .prepare(
          `SELECT DISTINCT sf.id, sf.path FROM edges e
           JOIN files sf ON sf.id = e.src_id
           WHERE e.type IN ('imports', 'references') AND e.dst_kind = 'file' AND e.dst_id = ?
           ORDER BY sf.path`,
        )
        .all(fileId) as Array<{ id: number; path: string }>
    ).map((row) => ({ id: `file:${row.id}`, path: row.path })),
    summary,
    shortSummary: readSummary(db, "file", file.path, "tooltip-summary", file.hash),
    ...readPseudocode(db, "file", file.path, file.hash),
    grounding: groundText(db, summary, {
      fileId,
      packageDir: file.packageDir,
      source: repoRoot === undefined ? undefined : readSourceText(repoRoot, file.path),
    }),
    tests: fileTests(db, symbols.filter((s) => (s.kind === "function" || s.kind === "method") && s.implemented === 1).map((s) => s.id)),
    history: fileHistory(db, fileId),
  };
}

function fileTests(db: Db, functionIds: readonly number[]): FileDetailDto["tests"] {
  if (functionIds.length === 0) return null;
  const covered = (db.prepare(
    `SELECT COUNT(*) AS n FROM test_coverage WHERE symbol_id IN (${functionIds.map(() => "?").join(",")})`,
  ).get(...functionIds) as { n: number }).n;
  return { functions: functionIds.length, covered, cases: casesReaching(db, functionIds).size };
}

function readSourceText(repoRoot: string, path: string): string | undefined {
  try {
    return readFileSync(join(repoRoot, path), "utf8");
  } catch {
    return undefined;
  }
}

/** Only read the original source code when repoRoot is given, to determine whether the names mentioned in the AI summary are made up. */
export function getSymbolDetail(db: Db, symbolId: number, repoRoot?: string): SymbolDetailDto | null {
  const row = db
    .prepare(
      `SELECT s.*, f.path AS filePath, f.id AS fileId, f.language, p.dir AS packageDir
       FROM symbols s JOIN files f ON f.id = s.file_id LEFT JOIN packages p ON p.id = f.package_id WHERE s.id = ?`,
    )
    .get(symbolId) as
    | (Record<string, unknown> & {
        filePath: string;
        fileId: number;
        language: string;
        packageDir: string | null;
      })
    | undefined;

  if (!row) return null;

  const params: ParamDto[] = row["params"]
    ? (JSON.parse(row["params"] as string) as ParamDto[])
    : [];

  // Both directions must simultaneously constrain src_kind and dst_kind. The id space of edges is according to kind
  // Separated, the src_id of the file-level call edge is the file id, and if you only join without filtering, it will join out of thin air
  // A symbol with exactly the same id becomes a caller that doesn't exist at all.
  const relation = (direction: "callers" | "callees") =>
    db
      .prepare(
        direction === "callers"
          ? `SELECT s.id, s.name, s.container, s.kind, f.path, e.line, s.start_line AS defLine, e.confidence, e.candidates, e.call_kind AS callKind
             FROM edges e JOIN symbols s ON s.id = e.src_id JOIN files f ON f.id = s.file_id
             WHERE e.type = 'calls' AND e.src_kind = 'symbol'
               AND e.dst_kind = 'symbol' AND e.dst_id = ?
             ORDER BY e.weight DESC LIMIT 200`
          : `SELECT s.id, s.name, s.container, s.kind, f.path, e.line, s.start_line AS defLine, e.confidence, e.candidates, e.call_kind AS callKind
             FROM edges e JOIN symbols s ON s.id = e.dst_id JOIN files f ON f.id = s.file_id
             WHERE e.type = 'calls' AND e.dst_kind = 'symbol'
               AND e.src_kind = 'symbol' AND e.src_id = ?
             ORDER BY e.weight DESC LIMIT 200`,
      )
      .all(symbolId) as Array<{
      id: number;
      name: string;
      container: string | null;
      kind: string;
      path: string;
      line: number | null;
      defLine: number;
      confidence: string;
      candidates: string | null;
      callKind: string | null;
    }>;

  const candidatePaths = db.prepare(
    `SELECT s.id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  );

  const toRelationDto = (r: ReturnType<typeof relation>[number]): RelationDto => ({
    id: `sym:${r.id}`,
    name: r.container !== null ? `${r.container}.${r.name}` : r.name,
    kind: r.kind as SymbolKind,
    path: r.path,
    line: r.line ?? 0,
    definedAt: r.defLine,
    confidence: r.confidence as Confidence,
    // Candidates for ambiguous must be visible. Only one 'guessed' target is shown without giving other possibilities,
    // It disguises uncertainty as certainty—which is exactly what confidence grading aims to avoid.
    candidates:
      r.candidates === null
        ? null
        : (JSON.parse(r.candidates) as number[])
            .map((id) => candidatePaths.get(id) as { id: number; path: string } | undefined)
            .filter((c): c is { id: number; path: string } => c !== undefined)
            .map((c) => ({ id: `sym:${c.id}`, path: c.path })),
    ...(r.callKind === "render" ? { rendered: true } : {}),
    ...(r.callKind === "http" ? { http: true } : {}),
  });

  const externalCallees = db
    .prepare(
      `SELECT dst_name AS name, COUNT(*) AS count FROM edges
       WHERE type = 'calls' AND src_kind = 'symbol' AND src_id = ? AND dst_kind = 'external'
       GROUP BY dst_name ORDER BY count DESC`,
    )
    .all(symbolId) as Array<{ name: string; count: number }>;

  const typeRelations = db
    .prepare(
      "SELECT relation, target, target_id AS targetId FROM type_relations WHERE subject_id = ?",
    )
    .all(symbolId) as Array<{
    relation: "extends" | "implements" | "embeds";
    target: string;
    targetId: number | null;
  }>;

  const name = row["name"] as string;
  const container = (row["container"] as string | null) ?? null;
  const summaryKey = symbolKey(
    row["filePath"],
    container,
    name,
    row["start_line"] as number,
  );
  const summary = readSummary(db, "symbol", summaryKey, "summary-v2", row["hash"] as string);

  return {
    id: `sym:${symbolId}`,
    name,
    kind: row["kind"] as SymbolKind,
    container,
    filePath: row["filePath"],
    fileId: `file:${row["fileId"]}`,
    language: row["language"] as Language,
    exported: row["exported"] === 1,
    signature: (row["signature"] as string | null) ?? null,
    params,
    returnType: (row["return_type"] as string | null) ?? null,
    doc: (row["doc"] as string | null) ?? null,
    startLine: row["start_line"] as number,
    endLine: row["end_line"] as number,
    complexity: row["complexity"] as number,
    isAsync: row["is_async"] === 1,
    receiverType: (row["receiver_type"] as string | null) ?? null,
    callers: relation("callers").map(toRelationDto),
    callees: relation("callees").map(toRelationDto),
    externalCallees,
    typeRelations: typeRelations.map((t) => ({
      relation: t.relation,
      target: t.target,
      targetId: t.targetId !== null ? `sym:${t.targetId}` : null,
    })),
    summary,
    shortSummary: readSummary(db, "symbol", summaryKey, "tooltip-summary", row["hash"] as string),
    ...readPseudocode(db, "symbol", summaryKey, row["hash"] as string),
    grounding: groundText(db, summary, {
      fileId: row.fileId,
      packageDir: row.packageDir,
      source: repoRoot === undefined
        ? undefined
        : readSourceText(repoRoot, row.filePath)?.split("\n").slice((row["start_line"] as number) - 1, row["end_line"] as number).join("\n"),
    }),
    tests: testCoverageOf(db, symbolId),
    testKind: (row["test_kind"] as SymbolDetailDto["testKind"]) ?? null,
  };
}

export function symbolKey(
  filePath: string,
  container: string | null,
  name: string,
  startLine?: number,
): string {
  const base = container !== null ? `${filePath}#${container}.${name}` : `${filePath}#${name}`;
  return startLine === undefined ? base : `${base}:${startLine}`;
}

// ---------------------------------------------------------------------------
// Search and source code
// ---------------------------------------------------------------------------

export function search(
  db: Db,
  query: string,
  limit = 30,
  roles: FileRole[] = DEFAULT_ROLES,
): SearchHitDto[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // FTS5 prefix queries require explicitly adding * and escaping quotes to avoid syntax errors
  const ftsQuery = trimmed
    .split(/\s+/)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(" ");

  // Role filtering must go into SQL instead of filtering after getting the results: test file when searching for 'session'
  // Being able to take up 25 out of the top 30, and then filtering afterwards is equivalent to cutting the number of results down to single digits
  const rolePlaceholders = roles.map(() => "?").join(",");
  const roleFilter = `AND role IN (${rolePlaceholders})`;

  let rows: Array<{ label: string; detail: string; kind: string; ref: string; rank: number }>;
  try {
    rows = db
      .prepare(
        `SELECT label, detail, kind, ref, rank FROM search_index
         WHERE search_index MATCH ? ${roleFilter} ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, ...roles, limit) as typeof rows;
  } catch {
    // When the query string contains FTS reserved syntax, it falls back to LIKE
    rows = db
      .prepare(
        `SELECT label, detail, kind, ref, 0 AS rank FROM search_index
         WHERE label LIKE ? ${roleFilter} LIMIT ?`,
      )
      .all(`%${trimmed}%`, ...roles, limit) as typeof rows;
  }

  return rows.map((row) => ({
    id: row.ref,
    kind: row.kind as SearchHitDto["kind"],
    label: row.label,
    detail: row.detail,
    score: -row.rank,
  }));
}

export function getSource(
  db: Db,
  repoRoot: string,
  fileId: number,
  startLine?: number,
  endLine?: number,
): SourceSliceDto | null {
  const row = db.prepare("SELECT path, language FROM files WHERE id = ?").get(fileId) as
    | { path: string; language: string }
    | undefined;
  if (!row) return null;

  let text: string;
  try {
    text = readFileSync(join(repoRoot, row.path), "utf8");
  } catch {
    return null;
  }

  const lines = text.split("\n");
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? lines.length);

  return {
    path: row.path,
    language: row.language as Language,
    startLine: from,
    endLine: to,
    code: lines.slice(from - 1, to).join("\n"),
  };
}

/** README only needs to be read this many bytes to understand the intent; anything longer is mostly API documentation, go to the source code page to check. */
const README_MAX_BYTES = 64 * 1024;

/** Files like README, README.md, README.zh-CN.md, readme_cn.txt; readme-utils.ts does not count */
const README_NAME = /^readme(?:[._-][a-z]{2}(?:[-_][a-z]{2,4})?(?=\.))?(?:\.(md|mdx|markdown|rst|txt))?$/i;

/**
 * Package / Directory's own README: Only recognizes those placed directly at this level, the ones in subdirectories belong to the subdirectories.
 * When there are multiple files on the same level, README.md is preferred, followed by other markdown files (multi-language versions), then files without extensions, and finally rst / txt files.
 */
export function getScopeReadme(db: Db, repoRoot: string, scopeId: string): ReadmeDto | null {
  const dir = scopeId.startsWith("pkg:")
    ? packageDir(db, scopeId.slice(4))
    : scopeId.startsWith("dir:") ? scopeId.slice(4) : null;
  if (dir === null) return null;

  const rows = db
    .prepare("SELECT id, path, name FROM files WHERE dir_path = ? AND name LIKE 'readme%'")
    .all(dir) as Array<{ id: number; path: string; name: string }>;
  const candidates = rows.flatMap((row) => {
    const match = README_NAME.exec(row.name);
    return match ? [{ ...row, ext: match[1]?.toLowerCase() }] : [];
  });
  const rank = (row: { name: string; ext: string | undefined }) =>
    row.name.toLowerCase() === "readme.md" ? 0
      : row.ext === "md" || row.ext === "mdx" || row.ext === "markdown" ? 1
        : row.ext === undefined ? 2 : 3;
  candidates.sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length || a.name.localeCompare(b.name));

  for (const pick of candidates) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(repoRoot, pick.path));
    } catch {
      continue;
    }
    const truncated = bytes.length > README_MAX_BYTES;
    let content = bytes.subarray(0, README_MAX_BYTES).toString("utf8");
    // The truncation point may fall in the middle of a multi-byte character or a line, so revert to the previous complete line
    if (truncated) content = content.slice(0, Math.max(0, content.lastIndexOf("\n")));
    return {
      fileId: `file:${pick.id}`,
      path: pick.path,
      format: pick.ext === "rst" || pick.ext === "txt" || pick.ext === undefined ? "text" : "markdown",
      content,
      truncated,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Semantic layer read (written by M3, readable from M1 onward, null if not present)
// ---------------------------------------------------------------------------

function readSummary(
  db: Db,
  targetKind: string,
  targetKey: string,
  flavor: SemanticTextFlavor = "summary",
  sourceHash?: string,
): string | null {
  const args: unknown[] = [targetKind, targetKey, flavor, semanticLanguage(db)];
  const hashClause = sourceHash === undefined ? "" : "AND source_hash = ?";
  if (sourceHash !== undefined) args.push(sourceHash);
  const row = db
    .prepare(
      `SELECT content FROM summaries
       WHERE target_kind = ? AND target_key = ? AND flavor = ? AND lang = ? ${hashClause}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...args) as { content: string } | undefined;
  if (!row) return null;
  const lang = semanticLanguage(db);
  const content = normalizeSemanticContent(row.content, flavor, lang === "en" ? "en" : "zh");
  return content === "" ? null : content;
}

/** When the old cache only has text and no line number mapping, it falls back to a step without lines. */
function readPseudocode(
  db: Db,
  targetKind: "file" | "symbol",
  targetKey: string,
  sourceHash: string,
): { pseudocode: string | null; pseudocodeSteps: PseudocodeStepDto[] | null } {
  const pseudocode = readSummary(db, targetKind, targetKey, "pseudocode", sourceHash);
  if (pseudocode === null) return { pseudocode: null, pseudocodeSteps: null };
  const mapped = readSummary(db, targetKind, targetKey, "pseudocode-map", sourceHash);
  return {
    pseudocode,
    pseudocodeSteps: (mapped ? parsePseudocodeSteps(mapped) : null) ?? parsePseudocodeText(pseudocode),
  };
}

/** Scan period summary for the package, directory, or repository root itself; other nodes return null. */
export function getScopeSummary(db: Db, nodeId: string): string | null {
  if (nodeId === ROOT_SCOPE) return readSummary(db, "repo", ".");
  if (nodeId.startsWith("pkg:")) return readSummary(db, "package", nodeId.slice(4));
  if (nodeId.startsWith("dir:")) return readSummary(db, "directory", nodeId.slice(4));
  return null;
}

/** Attach the scanning period summary and architecture layer to the graph nodes; structural facts do not depend on these fields. Confirmed layering takes precedence over AI suggestions. */
function attachSemantics(db: Db, nodes: GraphNodeDto[]): void {
  if (nodes.length === 0) return;
  const layerByNode = new Map<string, string>();
  const confirmed = confirmedLayers(db);
  if (confirmed.length > 0) {
    for (const layer of confirmed) for (const id of layer.members) if (!layerByNode.has(id)) layerByNode.set(id, layer.name);
  } else {
    for (const row of db.prepare("SELECT name, members FROM layers ORDER BY ordinal").all() as Array<{ name: string; members: string }>) {
      for (const id of parseStringArray(row.members)) if (!layerByNode.has(id)) layerByNode.set(id, row.name);
    }
  }

  const lang = semanticLanguage(db);
  const summary = db.prepare(
    `SELECT content FROM summaries
     WHERE target_kind = ? AND target_key = ? AND flavor = 'summary' AND lang = ?
     ORDER BY created_at DESC LIMIT 1`,
  );
  const symbolSemantic = db.prepare(
    `SELECT sm.content FROM symbols s JOIN files f ON f.id = s.file_id
     JOIN summaries sm ON sm.target_kind = 'symbol'
       AND sm.target_key = (CASE WHEN s.container IS NULL THEN f.path || '#' || s.name
                                ELSE f.path || '#' || s.container || '.' || s.name END) || ':' || s.start_line
       AND sm.flavor = ? AND sm.lang = ? AND sm.source_hash = s.hash
     WHERE s.id = ? ORDER BY sm.created_at DESC LIMIT 1`,
  );
  const fileSemantic = db.prepare(
    `SELECT sm.content FROM files f JOIN summaries sm ON sm.target_kind = 'file'
       AND sm.target_key = f.path AND sm.flavor = ? AND sm.lang = ? AND sm.source_hash = f.hash
     WHERE f.id = ? ORDER BY sm.created_at DESC LIMIT 1`,
  );

  for (const node of nodes) {
    node.layer = layerByNode.get(node.id) ?? null;
    let row: { content: string } | undefined;
    if (node.kind === "package") row = summary.get("package", node.id.slice(4), lang) as { content: string } | undefined;
    else if (node.kind === "directory") row = summary.get("directory", node.path ?? node.id.slice(4), lang) as { content: string } | undefined;
    else if (node.kind === "file") {
      const id = Number(node.id.slice(5));
      row = fileSemantic.get("tooltip-summary", lang, id) as { content: string } | undefined;
      row ??= fileSemantic.get("summary-v2", lang, id) as { content: string } | undefined;
    } else if (node.kind === "symbol") {
      const id = Number(node.id.slice(4));
      row = symbolSemantic.get("tooltip-summary", lang, id) as { content: string } | undefined;
      row ??= symbolSemantic.get("summary-v2", lang, id) as { content: string } | undefined;
    }
    if (!row) node.summary = null;
    else {
      const flavor = node.kind === "file" || node.kind === "symbol"
        ? "tooltip-summary"
        : "summary";
      node.summary = normalizeSemanticContent(
        row.content, flavor, lang === "en" ? "en" : "zh",
      ) || null;
    }
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function nodeMetricsZero(): NodeMetrics {
  return { loc: 0, files: 0, symbols: 0, complexity: 0, inDegree: 0, outDegree: 0 };
}

export { depthOf };

// ---------------------------------------------------------------------------
// Architecture Assessment
// ---------------------------------------------------------------------------

/**
 * Attach health check counts to a batch of graph nodes.
 *
 * The previous volume highlights the key points here: repeated implementation naturally hangs on symbols, but only if it is visible at the symbol level,
 * One has to drill down to the function level to find the problem, which is equivalent to not having done it at all. So package/directory/file nodes should follow
 * The path prefix aggregates the number of issues from descendants, so at any level on the chart, you can see 'there are issues underneath.'
 */
export function attachFindings(db: Db, nodes: GraphNodeDto[]): void {
  if (nodes.length === 0) return;

  // Precise hit: the node itself is the mounting point of the problem (circular dependency, symbol-level duplication)
  const exact = new Map<string, number>();
  for (const row of db
    .prepare("SELECT scope_key AS k, COUNT(*) AS n FROM findings GROUP BY scope_key")
    .all() as Array<{ k: string; n: number }>) {
    exact.set(row.k, row.n);
  }

  // Prefix hit: the issue of descendants rolls up to the container node
  const byPath = db.prepare(
    `SELECT COUNT(*) AS n, SUM(severity = 'high') AS high FROM findings
     WHERE path = ? OR path LIKE ? || '/%'`,
  );

  for (const node of nodes) {
    if (node.kind === "external" || node.kind === "aggregate") continue;

    if (node.kind === "symbol") {
      const n = exact.get(node.id) ?? 0;
      if (n > 0) node.findings = { count: n, high: 0 };
      continue;
    }

    const path = node.path;
    if (path === undefined || path === null) continue;
    const row = byPath.get(path, path) as { n: number; high: number | null };
    const self = exact.get(node.id) ?? 0;
    // On the directory/package node, its own circular dependencies are also included; its path is itself,
    // So it has already been overridden by the prefix query and will no longer stack.
    const count = Math.max(row.n, self);
    if (count > 0) node.findings = { count, high: row.high ?? 0 };
  }
}

export function getFindings(db: Db, options: FindingQuery = {}): FindingDto[] {
  const where: string[] = [];
  const args: unknown[] = [];

  if (options.kind) {
    where.push(`kind = ?`);
    args.push(options.kind);
  }
  const scope = findingScope(db, options.scope);
  if (scope) {
    where.push(scope.clause);
    args.push(...scope.args);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  // A set of questions presents only one at a time. Hanging it on each member is to make it visible everywhere on the diagram,
  // But listing the same thing repeatedly in the list only creates noise.
  const rows = db
    .prepare(
      `SELECT group_key AS groupKey, kind, severity, scope_kind AS scopeKind,
              MIN(scope_key) AS scopeKey, MIN(path) AS path,
              MIN(title) AS title, MIN(detail) AS detail, MIN(related) AS related,
              COUNT(*) AS members
       FROM findings ${clause}
       GROUP BY group_key`,
    )
    .all(...args) as Array<{
    groupKey: string;
    kind: string;
    severity: string;
    scopeKind: string;
    scopeKey: string;
    path: string;
    title: string;
    detail: string;
    related: string;
    members: number;
  }>;

  // Within the same severity level, prioritize the code that has been recently changed frequently: problems there are most likely to grow and should be looked at first.
  const recent = recentCommitsByPath(db);
  const rank = (severity: string) => (severity === "high" ? 0 : severity === "medium" ? 1 : 2);
  return rows
    .map((r) => ({
      groupKey: r.groupKey,
      kind: r.kind as FindingKind,
      severity: r.severity as FindingSeverity,
      scopeKind: r.scopeKind as FindingDto["scopeKind"],
      scopeKey: r.scopeKey,
      path: r.path,
      title: r.title,
      detail: r.detail,
      related: JSON.parse(r.related) as string[],
      members: r.members,
      ...(recent.size > 0 ? { recentCommits: recent.get(r.path) ?? sumUnder(recent, r.path) } : {}),
    }))
    .sort((a, b) =>
      rank(a.severity) - rank(b.severity) || (b.recentCommits ?? 0) - (a.recentCommits ?? 0) ||
      b.members - a.members || a.groupKey.localeCompare(b.groupKey))
    .slice(0, options.limit ?? 200);
}

function recentCommitsByPath(db: Db): Map<string, number> {
  return new Map((db.prepare("SELECT path, recent FROM file_history WHERE recent > 0").all() as Array<{ path: string; recent: number }>)
    .map((row) => [row.path, row.recent]));
}

/** Issues at the package and directory level are totaled according to the number of submissions of the following files */
function sumUnder(recent: ReadonlyMap<string, number>, dir: string): number {
  if (dir === "" || dir === ".") return 0;
  let total = 0;
  for (const [path, count] of recent) if (path.startsWith(`${dir}/`)) total += count;
  return total;
}

export function getFindingSummary(db: Db, scope?: string): FindingSummaryDto {
  const filter = findingScope(db, scope);
  const rows = db
    .prepare(
      `SELECT kind, severity, COUNT(DISTINCT group_key) AS n FROM findings
       ${filter ? `WHERE ${filter.clause}` : ""} GROUP BY kind, severity`,
    )
    .all(...(filter?.args ?? [])) as Array<{ kind: string; severity: string; n: number }>;

  const summary: FindingSummaryDto = { total: 0, high: 0, byKind: {} };
  for (const row of rows) {
    summary.total += row.n;
    if (row.severity === "high") summary.high += row.n;
    summary.byKind[row.kind] = (summary.byKind[row.kind] ?? 0) + row.n;
  }
  return summary;
}

/**
 * The physical examination conclusions are limited to a certain graph node. Packages and directories follow the path prefix, consistent with drilling down on the graph; files are taken as themselves and
 * The symbols inside (the path of the symbol conclusion is the file it belongs to); only take the symbols attached to it. Unrecognizable nodes are not filtered.
 */
function findingScope(db: Db, scope: string | undefined): { clause: string; args: unknown[] } | null {
  if (scope === undefined || scope === ROOT_SCOPE) return null;
  const underPath = (path: string) =>
    path === "." ? null : { clause: `(path = ? OR path LIKE ? || '/%')`, args: [path, path] };
  if (scope.startsWith("dir:")) return underPath(scope.slice(4));
  if (scope.startsWith("pkg:")) {
    const row = db.prepare("SELECT dir FROM packages WHERE name = ?").get(scope.slice(4)) as { dir: string } | undefined;
    return row ? underPath(row.dir) : null;
  }
  if (scope.startsWith("file:")) {
    const row = db.prepare("SELECT path FROM files WHERE id = ?").get(Number(scope.slice(5))) as { path: string } | undefined;
    return row ? { clause: "path = ?", args: [row.path] } : null;
  }
  if (scope.startsWith("sym:")) return { clause: "scope_key = ?", args: [scope] };
  return null;
}

/**
 * The expansion chain from the root to the target node.
 *
 * Reason for existence: The search and physical examination checklist both provide deep nodes, while the graph only loads the current layer.
 * Without this link, clicking the result can only open the detail drawer, and the image stays in place — you have to go through it layer by layer yourself.
 * Drilling back to find it is equivalent to the navigation not being connected.
 *
 * Each item returned is a scope ID that can be directly passed to loadScope, sorted from outer to inner.
 */
export function getRevealChain(db: Db, nodeId: string): string[] {
  const filePathOf = (id: number): string | null => {
    const row = db.prepare("SELECT path FROM files WHERE id = ?").get(id) as
      | { path: string }
      | undefined;
    return row?.path ?? null;
  };

  let leafPath: string | null = null;
  let leafScope: string | null = null;

  if (nodeId.startsWith("sym:")) {
    const row = db
      .prepare("SELECT file_id AS fileId FROM symbols WHERE id = ?")
      .get(Number(nodeId.slice(4))) as { fileId: number } | undefined;
    if (!row) return [];
    leafPath = filePathOf(row.fileId);
    leafScope = `file:${row.fileId}`;
  } else if (nodeId.startsWith("file:")) {
    leafPath = filePathOf(Number(nodeId.slice(5)));
    leafScope = nodeId;
  } else if (nodeId.startsWith("dir:")) {
    leafPath = nodeId.slice(4);
    leafScope = null;
  } else if (nodeId.startsWith("pkg:")) {
    // The package node is directly attached to the root scope, with no intermediate layer.
    return [];
  } else {
    return [];
  }

  if (leafPath === null) return [];

  // A directory node is itself a scope, and the chain ends at its parent directory; the chain for a file/symbol must include the directory it is in.
  const dirPath = leafScope === null ? dirOf(leafPath) : dirOf(leafPath);
  const segments = dirPath === "." ? [] : dirPath.split("/");

  // When the root view has package-level diagrams enabled, only nodes falling within a package start with pkg:; in a single package or when degenerated into a directory view, they all start from the top-level directory.
  const pkg = hasPackageGraph(db)
    ? (db
        .prepare(
          `SELECT name, dir FROM packages
           WHERE ? = dir OR ? LIKE dir || '/%'
           ORDER BY LENGTH(dir) DESC LIMIT 1`,
        )
        .get(dirPath, dirPath) as { name: string; dir: string } | undefined)
    : undefined;

  const chain: string[] = [];
  let startIndex = 0;

  if (pkg) {
    chain.push(`pkg:${pkg.name}`);
    startIndex = pkg.dir === "." ? 0 : pkg.dir.split("/").length;
  }

  for (let i = startIndex; i < segments.length; i++) {
    chain.push(`dir:${segments.slice(0, i + 1).join("/")}`);
  }

  if (leafScope !== null && nodeId.startsWith("sym:")) chain.push(leafScope);

  return chain;
}
