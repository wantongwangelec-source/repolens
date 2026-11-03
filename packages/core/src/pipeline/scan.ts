import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadLock } from "../config.js";
import { getMeta, indexPath, openDb, setMeta, setMetaJson, transact, type Db } from "../db/database.js";
import { getIndexTotals } from "../db/queries.js";
import { IndexWriter, type CallSiteRow, type ImportRow, type TypeRelationRow } from "../db/writer.js";
import { isAnalyzable } from "../discovery/language.js";
import { hashContent, walkRepo } from "../discovery/walk.js";
import { discoverPackages } from "../discovery/workspace.js";
import { attachDeclarationOnly, attachShapes } from "../parse/ast-utils.js";
import { attachControlFlow } from "../parse/control-flow.js";
import { prepareSource } from "../parse/embedded.js";
import { extractorFor } from "../parse/extractors/registry.js";
import { ParserPool } from "../parse/parser-pool.js";
import { ancestorDirs, baseName, dirOf } from "../resolve/path-utils.js";
import { createResolvers } from "../resolve/registry.js";
import { enrichRepository } from "../llm/enrich.js";
import type {
  Confidence,
  DiscoveredFile,
  DiscoveredPackage,
  ParsedFile,
  ParsedSymbol,
  AnalyzableLanguage,
  ResolveContext,
  ScanPhase,
  ScanStats,
  TestKind,
} from "../types.js";
import { clearHistory, collectHistory } from "./history.js";
import { linkGraph } from "./link.js";
import { countLoc, excludeNestedComplexity } from "./metrics.js";

export type { ScanPhase } from "../types.js";

/**
 * Increment by one if the shape or semantics of the extractor's output changes. Files whose content hasn't changed will also be re-parsed entirely.
 * Instead of rebuilding the entire library like with the schema version—which would also clear the LLM cache.
 */
export const EXTRACTOR_VERSION = "10";
export const EXTRACTOR_VERSION_KEY = "extractor_version";
/** If you need to re-parse so many files at once, clear the derived table first and then parse. */
const BULK_REPARSE = 200;
/** During the parsing phase, submit every this many files at a time */
const PARSE_COMMIT_BATCH = 50;

/**
 * Batch submission across await: parsing is asynchronous, better-sqlite3's transaction() can't wrap it, so manually use BEGIN / COMMIT;
 * The writing of each file is embedded inside as a SAVEPOINT. In case of an error, the entire batch is rolled back, and scanning still fails.
 */
class CommitBatch {
  private open = false;
  private pending = 0;

  constructor(private readonly db: Db, private readonly size: number) {}

  run(write: () => void): void {
    if (!this.open) {
      this.db.exec("BEGIN");
      this.open = true;
    }
    transact(this.db, write);
    if (++this.pending >= this.size) this.commit();
  }

  commit(): void {
    if (!this.open) return;
    this.db.exec("COMMIT");
    this.open = false;
    this.pending = 0;
  }

  rollback(): void {
    if (!this.open) return;
    this.db.exec("ROLLBACK");
    this.open = false;
    this.pending = 0;
  }
}

export interface ScanOptions {
  root: string;
  /** Ignore existing indexes and rebuild completely */
  fresh?: boolean;
  /** Only build the structural index, do not call the model, regardless of how the repository is configured (used for baseline snapshots of change comparisons) */
  structureOnly?: boolean;
  /**
   * Reading git history to count hotspots and collaborative changes, by default only when structureOnly is false: baseline snapshots are not in git,
   * The incremental refresh of watch should not run git log every time. When skipping, keep the history read last time. When the configuration is turned off, do not read.
   */
  history?: boolean;
  onProgress?: (phase: ScanPhase, done: number, total: number) => void;
}

interface PreviousFile {
  id: number;
  hash: string;
  parsed: number;
  /** The role and language are determined by the configuration. Even if the content hasn't changed, it must be re-entered into the database if the configuration is changed. */
  role: string;
  language: string;
}

/**
 * Scan arrangement.
 *
 * The phase division can be seen in docs/ARCHITECTURE.md#Analysis-pipeline. The key constraint here is
 * "All files must be stored in the database" must occur before "import parsing"—the parsing results need to be recorded in target_file_id.
 * And obtaining the id requires that the target file already has a record.
 */
export async function scanRepo(options: ScanOptions): Promise<ScanStats> {
  const started = Date.now();
  const { root } = options;
  const report = options.onProgress ?? (() => {});

  const loaded = loadConfig(root);
  const config = options.structureOnly ? { ...loaded, llm: { ...loaded.llm, enabled: false } } : loaded;

  report("discover", 0, 1);
  const discoveredPackages = discoverPackages(root);
  const walked = walkRepo(root, config, discoveredPackages);
  const packages = selectWorkspacePackages(discoveredPackages, walked.files);
  report("discover", 1, 1);

  const db = openDb(indexPath(root), { fresh: options.fresh ?? false });
  try {
    const writer = new IndexWriter(db);

    const stats = emptyStats();
    stats.filesDiscovered = walked.files.length;
    stats.packages = packages.length;

    const previous = loadPreviousFiles(db);
    if (getMeta(db, EXTRACTOR_VERSION_KEY) !== EXTRACTOR_VERSION) {
      for (const prev of previous.values()) prev.parsed = 0;
    }
    const discoveredPaths = new Set(walked.files.map((f) => f.path));

    const fileIdByPath = transact(db, () => {
      const { byDir: packageIdByDir, changed: packagesChanged } = writer.syncPackages(packages);
      writer.syncDirectories(collectDirectories(walked.files, walked.directories), packageIdByDir);

      for (const path of previous.keys()) {
        if (!discoveredPaths.has(path)) {
          writer.deleteFile(path);
          stats.filesDeleted++;
        }
      }

      const ids = new Map<string, number>();
      for (const file of walked.files) {
        const prev = previous.get(file.path);
        // Only compare content and classification: whether the parsing status is expired is judged separately by the following toParse.
        // Mixing in parsed will make all files that don’t need parsing (md/json/assets) every time
        // All the scans were re-read, which was purely a waste.
        if (
          prev &&
          prev.hash === file.hash &&
          prev.role === file.role &&
          prev.language === file.language
        ) {
          ids.set(file.path, prev.id);
          continue;
        }
        const loc = file.role === "asset" ? 0 : countLoc(readText(root, file.path), file.language);
        ids.set(
          file.path,
          writer.upsertFile(
            {
              path: file.path,
              language: file.language,
              role: file.role,
              bytes: file.bytes,
              hash: file.hash,
              loc,
              packageDir: file.packageDir,
            },
            packageIdByDir,
          ),
        );
      }

      // Adding or removing packages will change the ownership of a batch of existing files, even though the content of these files has not changed.
      // It won't go through the upsert above; we can only reconcile everything at once.
      if (packagesChanged) writer.reassignFilePackages();

      return ids;
    });

    const toParse = walked.files.filter((file) => {
      if (!isAnalyzable(file.language)) return false;
      if (file.role === "asset" || file.role === "vendor") return false;
      const prev = previous.get(file.path);
      return !(
        prev
        && prev.hash === file.hash
        && prev.role === file.role
        && prev.language === file.language
        && prev.parsed === 1
      );
    });

    stats.filesReused = walked.files.length - toParse.length;

    await parseChanged(db, writer, toParse, {
      root, fileIdByPath, stats, report,
      resolveCtx: buildResolveContext(root, discoveredPaths, walked.directories, discoveredPackages),
    });
    setMeta(db, EXTRACTOR_VERSION_KEY, EXTRACTOR_VERSION);

    report("link", 0, 1);
    if (options.history ?? !options.structureOnly) {
      const history = config.history ? transact(db, () => collectHistory(db, root)) : null;
      if (history === null) clearHistory(db);
      setMetaJson(db, "history", history);
      if (history) stats.history = history;
    }
    const lock = loadLock(root);
    // Queries only hold the index, the hierarchical structure and dependency lock defined in the agreement are recorded in meta, and the interface no longer needs to read the configuration file.
    setMetaJson(db, "confirmed_layers", config.layers);
    setMetaJson(db, "lock", lock ? { level: lock.level, dependencies: lock.dependencies.length } : null);
    const linkStats = transact(db, () => linkGraph(db, writer, { rules: config.rules, lock, layers: config.layers, root }));
    stats.calls = linkStats.calls;
    stats.callsByConfidence = linkStats.callsByConfidence;
    stats.http = linkStats.http;
    stats.tests = linkStats.tests;
    report("link", 1, 1);

    report("rollup", 0, 1);
    transact(db, () => writer.rollupDirectoryMetrics());
    report("rollup", 1, 1);

    // First stabilize the structural metadata, then try semantic enhancement. A model failure can only affect M3, it must never let
    // The successfully structured scan failed or is missing.
    setMeta(db, "repo_root", root);
    setMeta(db, "repo_name", baseName(root) === "." ? "repo" : baseName(root));
    setMeta(db, "scanned_at", new Date().toISOString());

    report("enrich", 0, 1);
    try {
      stats.llm = await enrichRepository(db, root, config.llm);
    } catch (err) {
      stats.llm = {
        enabled: config.llm.enabled,
        available: false,
        model: config.llm.model,
        generated: 0,
        cacheHits: 0,
        failures: 1,
        durationMs: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reason: (err as Error).message,
      };
    }
    report("enrich", 1, 1);

    report("index", 0, 1);
    transact(db, () => {
      // The scale in the report is for the entire warehouse, not just the few files parsed in this incremental run.
      const totals = getIndexTotals(db);
      stats.loc = totals.loc;
      stats.sourceLoc = totals.sourceLoc;
      stats.symbols = totals.symbols;
      stats.imports = totals.imports;
      stats.importsResolved = totals.importsResolved;
      stats.importsExternal = totals.importsExternal;
      stats.importsUnresolved = totals.importsUnresolved;
      stats.byLanguage = languageBreakdown(db);
      stats.durationMs = Date.now() - started;

      setMetaJson(db, "stats", stats);
    });
    report("index", 1, 1);
    return stats;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Analysis and Storage
// ---------------------------------------------------------------------------

/**
 * Parsing phase: Parse files one by one and import them into the database immediately. Although batching them in memory and writing all at once is faster, the AST of 1400 files...
 * The product will take up several hundred MB, not worth it. Submit in batches: each file is submitted individually, just writing the index page into the WAL
 * It takes up one-third of the scanning time.
 */
async function parseChanged(
  db: Db,
  writer: IndexWriter,
  toParse: readonly DiscoveredFile[],
  context: {
    root: string;
    fileIdByPath: ReadonlyMap<string, number>;
    resolveCtx: Omit<ResolveContext, "fromFile">;
    stats: ScanStats;
    report: NonNullable<ScanOptions["onProgress"]>;
  },
): Promise<void> {
  const { root, fileIdByPath, resolveCtx, stats, report } = context;
  // Derived tables are fully rebuilt during the linking phase. When batch re-parsing (upgrading the parser, switching branches), they are cleared first, so old symbols can be deleted without having to cascade through these large tables line by line.
  // When only a few files are changed, it's not clear, and during the watch refresh, the interface still reads the complete old image.
  if (toParse.length > BULK_REPARSE) transact(db, () => writer.clearDerived());

  const pool = new ParserPool();
  const resolvers = createResolvers();
  const batch = new CommitBatch(db, PARSE_COMMIT_BATCH);
  let done = 0;
  report("parse", 0, toParse.length);
  try {
    for (const file of toParse) {
      const fileId = fileIdByPath.get(file.path);
      if (fileId === undefined) continue;

      const source = readText(root, file.path);
      const parsed = await parseFile(pool, file, source);

      batch.run(() => {
        writer.clearFileArtifacts(fileId);
        if (parsed === null) {
          writer.markParsed(fileId, 0, "该语言的 tree-sitter 语法不可用");
          return;
        }
        persistParsed(writer, resolvers, resolveCtx, fileIdByPath, fileId, file, source, parsed, stats);
      });

      done++;
      if (done % 25 === 0 || done === toParse.length) report("parse", done, toParse.length);
    }
    batch.commit();
  } catch (err) {
    batch.rollback();
    throw err;
  } finally {
    pool.dispose();
  }
  stats.filesParsed = toParse.length;
}

async function parseFile(
  pool: ParserPool,
  file: DiscoveredFile,
  source: string,
): Promise<ParsedFile | null> {
  const embedded = prepareSource(file.language, source);
  const parserLanguage: AnalyzableLanguage | null = embedded
    ? embedded.parserLanguage
    : isAnalyzable(file.language)
      ? file.language
      : null;
  if (parserLanguage === null) return null;

  const parseSource = embedded?.source ?? source;
  const parser = await pool.parserFor(parserLanguage);
  if (!parser) return null;

  const tree = parser.parse(parseSource);
  if (!tree) return null;

  try {
    const parsed = extractorFor(parserLanguage).extract({
      root: tree.rootNode,
      source: parseSource,
      language: parserLanguage,
      path: file.path,
    });
    // The shape fingerprints and the control structures where the calls are located are calculated together here, rather than scattered across various extractors—they only depend on
    // AST is language-independent, and this is the only place that simultaneously holds the syntax tree, symbol table, and call points.
    attachShapes(tree.rootNode, parsed.symbols);
    attachDeclarationOnly(tree.rootNode, parsed.symbols);
    attachControlFlow(tree.rootNode, parsed.calls);
    return { ...parsed, symbols: excludeNestedComplexity(parsed.symbols) };
  } catch (err) {
    // The extraction of a single file should not interrupt the entire scan; leave the error in files.parse_error.
    return {
      symbols: [],
      imports: [],
      exports: [],
      calls: [],
      typeRelations: [],
      hasError: true,
      moduleDecls: [`抽取失败：${(err as Error).message}`],
    };
  } finally {
    tree.delete();
  }
}

function persistParsed(
  writer: IndexWriter,
  resolvers: ReturnType<typeof createResolvers>,
  baseCtx: Omit<ResolveContext, "fromFile">,
  fileIdByPath: ReadonlyMap<string, number>,
  fileId: number,
  file: DiscoveredFile,
  source: string,
  parsed: ParsedFile,
  stats: ScanStats,
): void {
  // startByte/endByte are string indices (UTF-16) used by tree-sitter when parsing text.
  // Not a UTF-8 byte; the parsed text of the composite component is the masked version and must be cut on top of it
  const parsedText = prepareSource(file.language, source)?.source ?? source;
  const symbolHashes = parsed.symbols.map((sym) =>
    hashContent(parsedText.slice(sym.startByte, sym.endByte)),
  );
  const testKinds = parsed.symbols.map((sym) => (file.role === "test" ? sym.testKind ?? conventionalTestKind(sym) : null));
  const symbolIds = writer.insertSymbols(fileId, parsed.symbols, symbolHashes, testKinds);

  // The caller must locate by 'container + name'. If you only check by name, there could be two classes in one file.
  // When each has a handleInput, the calls on both sides will all be recorded on the one that was declared first——
  // It is manifested as a small method of just three lines having hundreds of outgoing edges in the call graph.
  const symbolIdByKey = new Map<string, number>();
  // Both exports and type declarations are at the top level, using a separate mapping to avoid being overridden by methods with the same name.
  const topLevelIdByName = new Map<string, number>();
  for (const [i, sym] of parsed.symbols.entries()) {
    const id = symbolIds[i];
    if (id === undefined) continue;
    const key = symbolKey(sym.container ?? null, sym.name);
    if (!symbolIdByKey.has(key)) symbolIdByKey.set(key, id);
    if (sym.container == null && !topLevelIdByName.has(sym.name)) {
      topLevelIdByName.set(sym.name, id);
    }
  }

  writer.insertExports(fileId, parsed.exports, topLevelIdByName);

  const resolver = isAnalyzable(file.language) ? resolvers.get(file.language) : undefined;
  const importRows: ImportRow[] = [];

  for (const imp of parsed.imports) {
    stats.imports++;
    const outcome = resolver
      ? resolver.resolve(imp.source, { ...baseCtx, fromFile: file.path })
      : ({ status: "unresolved", reason: "该语言没有模块解析器" } as const);

    let confidence: Confidence;
    let targetFileId: number | null = null;
    let targetDir: string | null = null;
    let externalName: string | null = null;
    let unresolvedReason: string | null = null;

    switch (outcome.status) {
      case "internal":
        confidence = "exact";
        targetFileId = fileIdByPath.get(outcome.target) ?? null;
        if (targetFileId === null) {
          confidence = "unresolved";
          unresolvedReason = `目标文件未入库：${outcome.target}`;
          stats.importsUnresolved++;
        } else {
          stats.importsResolved++;
        }
        break;
      case "internal-dir":
        confidence = "exact";
        targetDir = outcome.target;
        stats.importsResolved++;
        break;
      case "external":
        confidence = "external";
        externalName = outcome.name;
        stats.importsExternal++;
        break;
      case "unresolved":
        confidence = "unresolved";
        unresolvedReason = outcome.reason;
        stats.importsUnresolved++;
        break;
    }

    importRows.push({
      rawSource: imp.source,
      kind: imp.kind,
      confidence,
      targetFileId,
      targetDir,
      externalName,
      unresolvedReason,
      isTypeOnly: imp.isTypeOnly ?? false,
      line: imp.line,
      specifiers: imp.specifiers.map((s) => ({
        imported: s.imported,
        local: s.local,
        isDefault: s.isDefault ?? false,
        isNamespace: s.isNamespace ?? false,
      })),
    });
  }

  writer.insertImports(fileId, importRows);

  const callSites: CallSiteRow[] = parsed.calls.map((call) => ({
    callerSymbolId:
      call.callerName !== null
        ? (symbolIdByKey.get(symbolKey(call.callerContainer ?? null, call.callerName)) ?? null)
        : null,
    calleeName: call.callee,
    receiver: call.receiver ?? null,
    receiverType: call.receiverType ?? null,
    calleePath: call.calleePath ? call.calleePath.join(".") : null,
    callKind: call.kind,
    argCount: call.argCount,
    argumentTexts: call.argumentTexts ?? [],
    line: call.line,
    endByte: call.endByte,
    nameLine: call.nameLine,
    nameColumn: call.nameColumn,
    blocks: call.blocks ?? null,
    discarded: call.discarded ?? false,
  }));
  writer.insertCallSites(fileId, callSites);
  writer.insertEntryHints(fileId, parsed.entryHints ?? []);

  const typeRelations: TypeRelationRow[] = parsed.typeRelations.map((rel) => ({
    subjectId: topLevelIdByName.get(rel.subject) ?? null,
    subject: rel.subject,
    relation: rel.relation,
    target: rel.target,
    targetId: null, // Cross-file type links are uniformly handled at the link stage
    confidence: "unresolved",
    line: rel.line,
  }));
  writer.insertTypeRelations(fileId, typeRelations);

  const fileComplexity = parsed.symbols.reduce((sum, s) => sum + s.complexity, 0);
  if (parsed.hasError) stats.parseErrors++;
  writer.markParsed(fileId, fileComplexity, parsed.hasError ? "存在语法错误节点" : null);
}

// ---------------------------------------------------------------------------
// Assistive
// ---------------------------------------------------------------------------

/** A unique key for the symbol within the file. Top-level symbols use their name directly, while members are separated by a container. */
function symbolKey(container: string | null, name: string): string {
  return container === null ? name : `${container}\u0000${name}`;
}

/**
 * Tests named according to the convention in the test file: pytest's `test_x` / `TestX` class, Go's `TestXxx`, JUnit 3's `testFoo`.
 * In helper function names like `testUtils`, the letters that follow are lowercase, so it doesn't count.
 */
function conventionalTestKind(symbol: ParsedSymbol): TestKind | null {
  if ((symbol.kind === "function" || symbol.kind === "method") && /^(?:test(?:_|[A-Z0-9]|$)|Test[A-Z_])/.test(symbol.name)) {
    return "case";
  }
  if ((symbol.kind === "class" || symbol.kind === "struct") && /^Test(?:[A-Z_]|$)/.test(symbol.name)) return "suite";
  return null;
}

/**
 * Filter out scattered subdirectory packages that do not form a full repository package structure.
 *
 * Go / Cargo / Python's package discovery will recursively look for manifest files in subdirectories. If the repository itself is not
 * monorepo, only placed independent script configurations in individual subdirectories like hack/ and workshops/, which they override
 * The source code is less than half of the full repository; writing them into the packages table would make the full repository be misjudged as containing only these few packages.
 * monorepo, and then remove the remaining top-level directories from the architecture diagram. This kind of list only remains in resolveCtx for assistance
 * Import resolution within subdirectories.
 */
function selectWorkspacePackages(
  packages: readonly DiscoveredPackage[],
  files: DiscoveredFile[],
): readonly DiscoveredPackage[] {
  if (packages.length === 0) return packages;
  if (packages.some((p) => p.dir === ".")) return packages;

  let totalSource = 0;
  let packagedSource = 0;
  let totalSourceBytes = 0;
  let packagedSourceBytes = 0;
  for (const file of files) {
    if (file.role !== "source") continue;
    totalSource++;
    totalSourceBytes += file.bytes;
    if (file.packageDir !== null) {
      packagedSource++;
      packagedSourceBytes += file.bytes;
    }
  }

  if (totalSource > 0 && (packagedSource * 2 < totalSource || packagedSourceBytes * 2 < Math.max(totalSourceBytes, 1))) {
    for (const file of files) file.packageDir = null;
    return [];
  }
  return packages;
}

function buildResolveContext(
  root: string,
  files: ReadonlySet<string>,
  directories: readonly string[],
  packages: readonly DiscoveredPackage[],
): Omit<ResolveContext, "fromFile"> {
  const dirSet = new Set(directories);
  dirSet.add(".");
  return {
    root,
    hasFile: (p) => files.has(p),
    hasDir: (p) => dirSet.has(p),
    packages,
  };
}

function collectDirectories(
  files: readonly DiscoveredFile[],
  walkedDirs: readonly string[],
): string[] {
  const dirs = new Set(walkedDirs);
  // The set obtained by walking the directory may miss levels that only appear in the paths, so use file paths to fill in the gaps.
  for (const file of files) {
    for (const dir of ancestorDirs(file.path)) dirs.add(dir);
    const parent = dirOf(file.path);
    if (parent !== ".") dirs.add(parent);
  }
  dirs.delete(".");
  return [...dirs];
}

function loadPreviousFiles(db: Db): Map<string, PreviousFile> {
  const rows = db.prepare("SELECT id, path, hash, parsed, role, language FROM files").all() as Array<{
    id: number;
    path: string;
    hash: string;
    parsed: number;
    role: string;
    language: string;
  }>;
  return new Map(
    rows.map((r) => [
      r.path,
      { id: r.id, hash: r.hash, parsed: r.parsed, role: r.role, language: r.language },
    ]),
  );
}

function languageBreakdown(db: Db): ScanStats["byLanguage"] {
  const rows = db
    .prepare(
      `SELECT language, COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc
       FROM files WHERE role != 'asset' GROUP BY language`,
    )
    .all() as Array<{ language: string; files: number; loc: number }>;
  const out: ScanStats["byLanguage"] = {};
  for (const row of rows) out[row.language] = { files: row.files, loc: row.loc };
  return out;
}

function readText(root: string, relPath: string): string {
  try {
    return readFileSync(join(root, relPath), "utf8");
  } catch {
    return "";
  }
}

function emptyStats(): ScanStats {
  return {
    durationMs: 0,
    filesDiscovered: 0,
    filesParsed: 0,
    filesReused: 0,
    filesDeleted: 0,
    symbols: 0,
    imports: 0,
    importsResolved: 0,
    importsExternal: 0,
    importsUnresolved: 0,
    calls: 0,
    callsByConfidence: {
      exact: 0,
      likely: 0,
      ambiguous: 0,
      external: 0,
      unresolved: 0,
    },
    parseErrors: 0,
    packages: 0,
    loc: 0,
    byLanguage: {},
  };
}
