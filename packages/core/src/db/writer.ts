import type {
  Confidence,
  ControlBlock,
  DiscoveredPackage,
  EdgeType,
  FindingKind,
  FindingSeverity,
  ParsedExport,
  ParsedEntryHint,
  ParsedSymbol,
  SymbolKind,
} from "../types.js";
import { baseName, depthOf, dirOf } from "../resolve/path-utils.js";
import type { Db } from "./database.js";

export interface FileRow {
  path: string;
  language: string;
  role: string;
  bytes: number;
  hash: string;
  loc: number;
  packageDir: string | null;
}

export interface FindingRow {
  kind: FindingKind;
  severity: FindingSeverity;
  scopeKind: "package" | "directory" | "file" | "symbol";
  /** Graph node id */
  scopeKey: string;
  /** Relative path of the warehouse, for aggregation of upper-level node prefixes */
  path: string;
  title: string;
  detail: string;
  related: string[];
  groupKey: string;
}

export interface ImportRow {
  rawSource: string;
  kind: string;
  confidence: Confidence;
  targetFileId: number | null;
  targetDir: string | null;
  externalName: string | null;
  unresolvedReason: string | null;
  isTypeOnly: boolean;
  line: number;
  specifiers: Array<{
    imported: string;
    local: string;
    isDefault: boolean;
    isNamespace: boolean;
  }>;
}

export interface CallSiteRow {
  callerSymbolId: number | null;
  calleeName: string;
  receiver: string | null;
  receiverType: string | null;
  calleePath: string | null;
  callKind: string;
  argCount: number;
  argumentTexts: string[];
  line: number;
  endByte: number;
  nameLine: number;
  nameColumn: number;
  blocks: ControlBlock[] | null;
  discarded: boolean;
}

export interface EdgeRow {
  type: EdgeType;
  srcKind: "file" | "symbol";
  srcId: number;
  dstKind: "file" | "symbol" | "external";
  dstId: number | null;
  dstName: string | null;
  confidence: Confidence;
  line: number | null;
  callKind: string | null;
  candidates: number[] | null;
  weight: number;
}

export interface RollupEdgeRow {
  level: "package" | "directory";
  type: EdgeType;
  src: string;
  dst: string;
  confidence: Confidence;
  count: number;
  weight: number;
}

export interface TypeRelationRow {
  subjectId: number | null;
  subject: string;
  relation: "extends" | "implements" | "embeds";
  target: string;
  targetId: number | null;
  confidence: Confidence;
  line: number;
}

export interface SearchRow {
  label: string;
  detail: string;
  kind: string;
  ref: string;
  /** Document role, used to ensure that search complies with and filters noise consistently with the graph */
  role: string;
}

/**
 * Batch write layer.
 *
 * All statements are precompiled once for reuse — there are hundreds of thousands of inserts on a 400,000-line repository,
 * The overhead of recompiling SQL each time dominates the total scan time.
 */
export class IndexWriter {
  private readonly stmts;
  /** clearFileArtifacts records the original symbol IDs, grouped by identityKey and ordered by occurrence */
  private readonly reusableIds = new Map<number, Map<string, number[]>>();

  constructor(private readonly db: Db) {
    this.stmts = {
      insertPackage: db.prepare(
        `INSERT INTO packages (name, dir, manager, version, entry_points)
         VALUES (@name, @dir, @manager, @version, @entryPoints)
         ON CONFLICT(dir) DO UPDATE SET
           name = excluded.name, manager = excluded.manager,
           version = excluded.version, entry_points = excluded.entry_points`,
      ),
      insertDirectory: db.prepare(
        `INSERT INTO directories (path, parent_path, name, depth, package_id)
         VALUES (@path, @parentPath, @name, @depth, @packageId)
         ON CONFLICT(path) DO UPDATE SET
           parent_path = excluded.parent_path, package_id = excluded.package_id`,
      ),
      insertFile: db.prepare(
        `INSERT INTO files (path, dir_path, name, language, role, package_id, loc, bytes, hash, parsed, parse_error, complexity)
         VALUES (@path, @dirPath, @name, @language, @role, @packageId, @loc, @bytes, @hash, 0, NULL, 0)
         ON CONFLICT(path) DO UPDATE SET
           language = excluded.language, role = excluded.role, package_id = excluded.package_id,
           loc = excluded.loc, bytes = excluded.bytes, hash = excluded.hash,
           parsed = 0, parse_error = NULL, complexity = 0`,
      ),
      fileId: db.prepare("SELECT id FROM files WHERE path = ?"),
      deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
      deleteFileSummary: db.prepare(
        "DELETE FROM summaries WHERE target_kind = 'file' AND target_key = ?",
      ),
      markParsed: db.prepare(
        "UPDATE files SET parsed = 1, parse_error = @error, complexity = @complexity WHERE id = @id",
      ),
      clearSymbols: db.prepare("DELETE FROM symbols WHERE file_id = ?"),
      clearImports: db.prepare("DELETE FROM imports WHERE file_id = ?"),
      clearExports: db.prepare("DELETE FROM exports WHERE file_id = ?"),
      clearCallSites: db.prepare("DELETE FROM call_sites WHERE file_id = ?"),
      clearEntryHints: db.prepare("DELETE FROM entry_hints WHERE file_id = ?"),
      clearTypeRelations: db.prepare("DELETE FROM type_relations WHERE file_id = ?"),
      insertSymbol: db.prepare(
        `INSERT INTO symbols
           (id, file_id, name, kind, container, exported, signature, params, return_type, doc,
            start_line, end_line, start_byte, end_byte, complexity, is_async, is_static, receiver_type, hash, shape, test_kind, implemented)
         VALUES
           (@id, @fileId, @name, @kind, @container, @exported, @signature, @params, @returnType, @doc,
            @startLine, @endLine, @startByte, @endByte, @complexity, @isAsync, @isStatic, @receiverType, @hash, @shape, @testKind, @implemented)`,
      ),
      symbolIdentities: db.prepare("SELECT id, kind, container, name FROM symbols WHERE file_id = ? ORDER BY start_byte"),
      insertImport: db.prepare(
        `INSERT INTO imports
           (file_id, raw_source, kind, confidence, target_file_id, target_dir, external_name,
            unresolved_reason, is_type_only, line)
         VALUES
           (@fileId, @rawSource, @kind, @confidence, @targetFileId, @targetDir, @externalName,
            @unresolvedReason, @isTypeOnly, @line)`,
      ),
      insertImportSpec: db.prepare(
        `INSERT INTO import_specifiers (import_id, imported, local, is_default, is_namespace)
         VALUES (@importId, @imported, @local, @isDefault, @isNamespace)`,
      ),
      insertExport: db.prepare(
        `INSERT INTO exports (file_id, name, kind, source, symbol_id, line)
         VALUES (@fileId, @name, @kind, @source, @symbolId, @line)`,
      ),
      insertFinding: db.prepare(
        `INSERT INTO findings (kind, severity, scope_kind, scope_key, path, title, detail, related, group_key)
         VALUES (@kind, @severity, @scopeKind, @scopeKey, @path, @title, @detail, @related, @groupKey)`,
      ),
      insertCallSite: db.prepare(
        `INSERT INTO call_sites
           (file_id, caller_symbol_id, callee_name, receiver, receiver_type, callee_path, call_kind, arg_count, argument_texts,
            line, end_byte, name_line, name_col, blocks, discarded)
         VALUES
           (@fileId, @callerSymbolId, @calleeName, @receiver, @receiverType, @calleePath, @callKind, @argCount, @argumentTexts,
            @line, @endByte, @nameLine, @nameColumn, @blocks, @discarded)`,
      ),
      insertEntryHint: db.prepare(
        `INSERT INTO entry_hints
           (file_id, kind, framework, handler_name, line, label, method, route, confidence, evidence)
         VALUES
           (@fileId, @kind, @framework, @handlerName, @line, @label, @method, @route, @confidence, @evidence)`,
      ),
      insertTypeRelation: db.prepare(
        `INSERT INTO type_relations
           (file_id, subject_id, subject, relation, target, target_id, confidence, line)
         VALUES
           (@fileId, @subjectId, @subject, @relation, @target, @targetId, @confidence, @line)`,
      ),
      insertEdge: db.prepare(
        `INSERT INTO edges
           (type, src_kind, src_id, dst_kind, dst_id, dst_name, confidence, line, call_kind, candidates, weight)
         VALUES
           (@type, @srcKind, @srcId, @dstKind, @dstId, @dstName, @confidence, @line, @callKind, @candidates, @weight)`,
      ),
      insertRollup: db.prepare(
        `INSERT INTO rollup_edges (level, type, src, dst, confidence, count, weight)
         VALUES (@level, @type, @src, @dst, @confidence, @count, @weight)
         ON CONFLICT(level, type, src, dst, confidence) DO UPDATE SET
           count = count + excluded.count, weight = weight + excluded.weight`,
      ),
      insertSearch: db.prepare(
        "INSERT INTO search_index (label, detail, kind, ref, role) VALUES (@label, @detail, @kind, @ref, @role)",
      ),
      deleteStaleFileSummary: db.prepare(
        "DELETE FROM summaries WHERE target_kind = 'file' AND target_key = @path AND source_hash != @hash",
      ),
      deleteSymbolSummariesForFile: db.prepare(
        `DELETE FROM summaries WHERE target_kind = 'symbol'
         AND substr(target_key, 1, length(@prefix)) = @prefix`,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Skeleton
  // -------------------------------------------------------------------------

  /**
   * Synchronize the package list, return the mapping from package directory to id, and whether the package set has changed.
   *
   * Here we deliberately avoid 'clear first and then rebuild': files.package_id is ON DELETE SET NULL
   * The foreign key, clearing it once will erase the package ownership of all files in the repository, while incremental scanning will only overwrite it.
   * The few files that were changed, the rest of the files permanently lose ownership from now on.
   */
  syncPackages(packages: readonly DiscoveredPackage[]): {
    byDir: Map<string, number>;
    changed: boolean;
  } {
    const before = new Set(
      (this.db.prepare("SELECT dir FROM packages").all() as Array<{ dir: string }>).map(
        (r) => r.dir,
      ),
    );

    for (const pkg of packages) {
      this.stmts.insertPackage.run({
        name: pkg.name,
        dir: pkg.dir,
        manager: pkg.manager,
        version: pkg.version ?? null,
        entryPoints: JSON.stringify(pkg.entryPoints),
      });
    }

    const keep = new Set(packages.map((p) => p.dir));
    const removeStale = this.db.prepare("DELETE FROM packages WHERE dir = ?");
    let removed = 0;
    for (const dir of before) {
      if (keep.has(dir)) continue;
      removeStale.run(dir);
      removed++;
    }

    const rows = this.db.prepare("SELECT id, dir FROM packages").all() as Array<{
      id: number;
      dir: string;
    }>;
    return {
      byDir: new Map(rows.map((r) => [r.dir, r.id])),
      changed: removed > 0 || packages.some((p) => !before.has(p.dir)),
    };
  }

  /**
   * Recalculate the package ownership of all files according to the path prefix.
   *
   * The attribution is entirely determined by the path, so this is a repeatable reconciliation, only when the package collection changes.
   * Only then is it necessary to run. Use substr instead of LIKE: underscores in directory names will be matched by LIKE
   * Treated as a wildcard, `a_b` would mismatched to `axb/`.
   */
  reassignFilePackages(): void {
    this.db.exec(`
      UPDATE files SET package_id = (
        SELECT p.id FROM packages p
        WHERE p.dir = '.'
           OR substr(files.path, 1, length(p.dir) + 1) = p.dir || '/'
        ORDER BY length(p.dir) DESC
        LIMIT 1
      )
    `);
  }

  syncDirectories(dirs: readonly string[], packageIdByDir: ReadonlyMap<string, number>): void {
    this.db.exec("DELETE FROM directories");
    const sorted = [...dirs].sort();
    for (const path of sorted) {
      this.stmts.insertDirectory.run({
        path,
        parentPath: dirOf(path) === path ? null : dirOf(path),
        name: baseName(path),
        depth: depthOf(path),
        packageId: nearestPackageId(path, packageIdByDir),
      });
    }
  }

  upsertFile(file: FileRow, packageIdByDir: ReadonlyMap<string, number>): number {
    this.stmts.insertFile.run({
      path: file.path,
      dirPath: dirOf(file.path),
      name: baseName(file.path),
      language: file.language,
      role: file.role,
      packageId:
        file.packageDir !== null ? (packageIdByDir.get(file.packageDir) ?? null) : null,
      loc: file.loc,
      bytes: file.bytes,
      hash: file.hash,
    });
    this.stmts.deleteStaleFileSummary.run({ path: file.path, hash: file.hash });
    // upsertFile will only process files that are new or whose content/category has changed. Symbol id, line number, and
    // Overloaded collections may change, so clearing the symbolic semantics of the file before re-parsing it is safer than mistakenly assigning them to functions with the same name.
    this.stmts.deleteSymbolSummariesForFile.run({ prefix: `${file.path}#` });
    const row = this.stmts.fileId.get(file.path) as { id: number } | undefined;
    if (!row) throw new Error(`文件写入后未能读回 id：${file.path}`);
    return row.id;
  }

  deleteFile(path: string): void {
    this.stmts.deleteFileSummary.run(path);
    this.stmts.deleteSymbolSummariesForFile.run({ prefix: `${path}#` });
    this.stmts.deleteFile.run(path);
  }

  /**
   * Clear all parsing products of a file, to be called before re-parsing. Before clearing, first record the IDs of the existing symbols.
   * The subsequent insertSymbols returns them to symbols of the same name and type.
   */
  clearFileArtifacts(fileId: number): void {
    const previous = new Map<string, number[]>();
    for (const row of this.stmts.symbolIdentities.all(fileId) as Array<{ id: number; kind: string; container: string | null; name: string }>) {
      const key = identityKey(row.kind, row.container, row.name);
      const ids = previous.get(key);
      if (ids) ids.push(row.id); else previous.set(key, [row.id]);
    }
    this.reusableIds.set(fileId, previous);
    this.stmts.clearEntryHints.run(fileId);
    this.stmts.clearCallSites.run(fileId);
    this.stmts.clearTypeRelations.run(fileId);
    this.stmts.clearExports.run(fileId);
    this.stmts.clearImports.run(fileId);
    this.stmts.clearSymbols.run(fileId);
  }

  markParsed(fileId: number, complexity: number, error: string | null): void {
    this.stmts.markParsed.run({ id: fileId, complexity, error });
  }

  // -------------------------------------------------------------------------
  // Decomposition products
  // -------------------------------------------------------------------------

  /**
   * Returns an array of symbol IDs in the same order as the input parameters; testKinds are test tags verified according to file roles.
   *
   * The symbols that remain in the re-parsed file continue to use the original ID (recognized by type, container, name, and order of occurrence): on the interface
   * The selected function and the call stack that is halfway through execution can still be referenced after the watch refreshes; they won't become invalid just because a line in the same file was changed.
   */
  insertSymbols(
    fileId: number,
    symbols: readonly ParsedSymbol[],
    hashes: readonly string[],
    testKinds: ReadonlyArray<string | null> = [],
  ): number[] {
    const reusable = this.reusableIds.get(fileId);
    this.reusableIds.delete(fileId);
    const kept = symbols.map((sym) => reusable?.get(identityKey(sym.kind, sym.container ?? null, sym.name))?.shift() ?? null);
    // Continuing to use the previously inserted id: the table does not have AUTOINCREMENT, and the new symbol may automatically be assigned the id that has just become available and hasn't been recycled yet.
    const order = symbols.map((_, i) => i).sort((a, b) => Number(kept[a] === null) - Number(kept[b] === null));
    const ids: number[] = new Array<number>(symbols.length);
    for (const i of order) {
      const sym = symbols[i]!;
      const info = this.stmts.insertSymbol.run({
        id: kept[i],
        fileId,
        name: sym.name,
        kind: sym.kind,
        container: sym.container ?? null,
        exported: sym.exported ? 1 : 0,
        signature: sym.signature ?? null,
        params: sym.params ? JSON.stringify(sym.params) : null,
        returnType: sym.returnType ?? null,
        doc: sym.doc ?? null,
        startLine: sym.startLine,
        endLine: sym.endLine,
        startByte: sym.startByte,
        endByte: sym.endByte,
        complexity: sym.complexity,
        isAsync: sym.isAsync ? 1 : 0,
        isStatic: sym.isStatic ? 1 : 0,
        receiverType: sym.receiverType ?? null,
        hash: hashes[i] ?? "",
        shape: sym.shape ?? null,
        testKind: testKinds[i] ?? null,
        implemented: sym.declarationOnly ? 0 : 1,
      });
      ids[i] = Number(info.lastInsertRowid);
    }
    return ids;
  }

  insertImports(fileId: number, imports: readonly ImportRow[]): void {
    for (const imp of imports) {
      const info = this.stmts.insertImport.run({
        fileId,
        rawSource: imp.rawSource,
        kind: imp.kind,
        confidence: imp.confidence,
        targetFileId: imp.targetFileId,
        targetDir: imp.targetDir,
        externalName: imp.externalName,
        unresolvedReason: imp.unresolvedReason,
        isTypeOnly: imp.isTypeOnly ? 1 : 0,
        line: imp.line,
      });
      const importId = Number(info.lastInsertRowid);
      for (const spec of imp.specifiers) {
        this.stmts.insertImportSpec.run({
          importId,
          imported: spec.imported,
          local: spec.local,
          isDefault: spec.isDefault ? 1 : 0,
          isNamespace: spec.isNamespace ? 1 : 0,
        });
      }
    }
  }

  insertExports(
    fileId: number,
    exportsList: readonly ParsedExport[],
    symbolIdByName: ReadonlyMap<string, number>,
  ): void {
    for (const exp of exportsList) {
      this.stmts.insertExport.run({
        fileId,
        name: exp.name,
        kind: exp.kind,
        source: exp.source ?? null,
        symbolId: exp.source ? null : (symbolIdByName.get(exp.local ?? exp.name) ?? null),
        line: exp.line,
      });
    }
  }

  insertCallSites(fileId: number, sites: readonly CallSiteRow[]): void {
    for (const site of sites) {
      this.stmts.insertCallSite.run({
        fileId,
        callerSymbolId: site.callerSymbolId,
        calleeName: site.calleeName,
        receiver: site.receiver,
        receiverType: site.receiverType,
        calleePath: site.calleePath,
        callKind: site.callKind,
        argCount: site.argCount,
        argumentTexts: JSON.stringify(site.argumentTexts),
        line: site.line,
        endByte: site.endByte,
        nameLine: site.nameLine,
        nameColumn: site.nameColumn,
        blocks: site.blocks && site.blocks.length > 0 ? JSON.stringify(site.blocks) : null,
        discarded: site.discarded ? 1 : 0,
      });
    }
  }

  insertEntryHints(fileId: number, hints: readonly ParsedEntryHint[]): void {
    for (const hint of hints) {
      this.stmts.insertEntryHint.run({
        fileId,
        kind: hint.kind,
        framework: hint.framework,
        handlerName: hint.handlerName ?? null,
        line: hint.line,
        label: hint.label,
        method: hint.method ?? null,
        route: hint.route ?? null,
        confidence: hint.confidence,
        evidence: hint.evidence,
      });
    }
  }

  insertTypeRelations(fileId: number, relations: readonly TypeRelationRow[]): void {
    for (const rel of relations) {
      this.stmts.insertTypeRelation.run({
        fileId,
        subjectId: rel.subjectId,
        subject: rel.subject,
        relation: rel.relation,
        target: rel.target,
        targetId: rel.targetId,
        confidence: rel.confidence,
        line: rel.line,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  /** Edges, aggregated edges, medical examination conclusions, test coverage, and data table access are all globally derived and are recalculated by clearing the entire table before each link. */
  clearDerived(): void {
    this.db.exec(
      "DELETE FROM io_reach; DELETE FROM entry_points; DELETE FROM edges; DELETE FROM rollup_edges; DELETE FROM search_index; " +
        "DELETE FROM findings; DELETE FROM test_coverage; DELETE FROM data_access",
    );
  }

  insertFindings(findings: readonly FindingRow[]): void {
    for (const f of findings) {
      this.stmts.insertFinding.run({
        kind: f.kind,
        severity: f.severity,
        scopeKind: f.scopeKind,
        scopeKey: f.scopeKey,
        path: f.path,
        title: f.title,
        detail: f.detail,
        related: JSON.stringify(f.related),
        groupKey: f.groupKey,
      });
    }
  }

  insertEdges(edges: readonly EdgeRow[]): void {
    for (const edge of edges) {
      this.stmts.insertEdge.run({
        type: edge.type,
        srcKind: edge.srcKind,
        srcId: edge.srcId,
        dstKind: edge.dstKind,
        dstId: edge.dstId,
        dstName: edge.dstName,
        confidence: edge.confidence,
        line: edge.line,
        callKind: edge.callKind,
        candidates: edge.candidates ? JSON.stringify(edge.candidates) : null,
        weight: edge.weight,
      });
    }
  }

  insertRollupEdges(edges: readonly RollupEdgeRow[]): void {
    for (const edge of edges) {
      this.stmts.insertRollup.run(edge);
    }
  }

  insertSearchRows(rows: readonly SearchRow[]): void {
    for (const row of rows) this.stmts.insertSearch.run(row);
  }

  /**
   * Accumulate file-level metrics up to the directory.
   *
   * Use a one-time SQL recursion instead of building the tree in JS: the number of directories could be in the thousands.
   * And this calculation essentially involves grouping and summing by path prefix, which is faster and simpler to hand over to SQLite.
   */
  rollupDirectoryMetrics(): void {
    this.db.exec(`
      UPDATE directories SET
        loc = COALESCE((
          SELECT SUM(f.loc) FROM files f
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0),
        file_count = COALESCE((
          SELECT COUNT(*) FROM files f
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0),
        complexity = COALESCE((
          SELECT SUM(f.complexity) FROM files f
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0),
        symbol_count = COALESCE((
          SELECT COUNT(*) FROM symbols s
          JOIN files f ON f.id = s.file_id
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0)
    `);
  }
}

function identityKey(kind: string, container: string | null, name: string): string {
  return `${kind}\u0000${container ?? ""}\u0000${name}`;
}

function nearestPackageId(
  dirPath: string,
  packageIdByDir: ReadonlyMap<string, number>,
): number | null {
  let candidate: string | null = dirPath;
  while (candidate !== null) {
    const id = packageIdByDir.get(candidate);
    if (id !== undefined) return id;
    const parent = dirOf(candidate);
    candidate = parent === candidate ? null : parent;
    if (candidate === ".") {
      return packageIdByDir.get(".") ?? null;
    }
  }
  return null;
}

export type { SymbolKind };
