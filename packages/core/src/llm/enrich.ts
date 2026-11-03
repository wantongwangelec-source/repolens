import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LlmConfig,
  LlmRunStats,
  PseudocodeStepDto,
  SemanticResultDto,
} from "../types.js";
import { loadConfig } from "../config.js";
import { architectureModules } from "../db/architecture.js";
import { getMeta, setMeta, type Db, transact } from "../db/database.js";
import { symbolKey } from "../db/queries.js";
import { addUsage, emptyUsage, LlmUnavailableError, OpenAiCompatibleClient } from "./client.js";
import {
  cleanSingleLine,
  cleanText,
  normalizePseudocodeSteps,
  normalizeSummary,
  parsePseudocodeSteps,
  parsePseudocodeText,
  pseudocodeStepsToText,
} from "../db/semantic-format.js";
import {
  getCachedSemantic,
  invalidateCachedSemantic,
  putCachedSemantic,
  type SemanticTargetKind,
} from "../db/semantic.js";
import { MAX_SOURCE_LINE_CHARS, numberSourceLines } from "./source-lines.js";
import { mergeLlmStatusUsage } from "./status.js";

interface SemanticTarget {
  kind: "package" | "directory";
  key: string;
  nodeId: string;
  hash: string;
  context: Record<string, unknown>;
}

interface BatchResponse {
  items?: Array<{ key?: unknown; summary?: unknown }>;
}

interface ArchitectureResponse {
  summary?: unknown;
  layers?: Array<{ name?: unknown; description?: unknown; nodeIds?: unknown }>;
}

interface SymbolSemanticResponse {
  summary?: unknown;
  shortSummary?: unknown;
  pseudocode?: unknown;
}

interface FileSemanticResponse {
  summary?: unknown;
  shortSummary?: unknown;
  pseudocode?: unknown;
}

const inflight = new Map<string, Promise<SemanticResultDto>>();

/** If the source code form sent to the model changes, increment it by one, and use dropSemanticsFromOutdatedInput to clear the affected cache */
const SEMANTIC_INPUT_VERSION = "2";
const SEMANTIC_INPUT_VERSION_KEY = "semantic_input_version";
const MAX_ARCHITECTURE_DEPENDENCIES = 150;

export function semanticInputOutdated(db: Db): boolean {
  return getMeta(db, SEMANTIC_INPUT_VERSION_KEY) !== SEMANTIC_INPUT_VERSION;
}

/**
 * From version 2 onwards, very long lines are shortened before being sent to the model. When there are very long lines in the source code, the old result was according to those lines
 * The large section of source code that is generated can be removed, and after deletion, the interface will regenerate according to the new input; other files and
 * The input of symbols hasn't changed, and the cache can be used as usual.
 */
export function dropSemanticsFromOutdatedInput(db: Db, root: string): void {
  if (!semanticInputOutdated(db)) return;
  const cached = db.prepare(
    "SELECT DISTINCT target_kind AS kind, target_key AS key FROM summaries WHERE target_kind IN ('file', 'symbol')",
  ).all() as Array<{ kind: "file" | "symbol"; key: string }>;
  const byPath = new Map<string, { file: boolean; symbolKeys: string[] }>();
  for (const row of cached) {
    const path = row.kind === "file" ? row.key : row.key.slice(0, row.key.indexOf("#"));
    const entry = byPath.get(path) ?? { file: false, symbolKeys: [] };
    if (row.kind === "file") entry.file = true;
    else entry.symbolKeys.push(row.key);
    byPath.set(path, entry);
  }

  const symbolsOf = db.prepare(
    `SELECT s.name, s.container, s.start_line AS startLine, s.end_line AS endLine
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?`,
  );
  const stale: Array<{ kind: "file" | "symbol"; key: string }> = [];
  for (const [path, entry] of byPath) {
    let lines: string[];
    try {
      lines = readFileSync(join(root, path), "utf8").split("\n");
    } catch {
      continue;
    }
    const hasLongLine = (from: number, to: number) =>
      lines.slice(from - 1, to).some((line) => line.length > MAX_SOURCE_LINE_CHARS);
    if (!hasLongLine(1, lines.length)) continue;
    if (entry.file) stale.push({ kind: "file", key: path });
    if (entry.symbolKeys.length === 0) continue;

    const ranges = new Map(
      (symbolsOf.all(path) as Array<{ name: string; container: string | null; startLine: number; endLine: number }>)
        .map((s) => [symbolKey(path, s.container, s.name, s.startLine), s] as const),
    );
    for (const key of entry.symbolKeys) {
      const range = ranges.get(key);
      if (range && hasLongLine(range.startLine, range.endLine)) stale.push({ kind: "symbol", key });
    }
  }

  transact(db, () => {
    const drop = db.prepare("DELETE FROM summaries WHERE target_kind = ? AND target_key = ?");
    for (const target of stale) drop.run(target.kind, target.key);
    setMeta(db, SEMANTIC_INPUT_VERSION_KEY, SEMANTIC_INPUT_VERSION);
  });
}

/** Semantic enhancement during scanning: only touch repo/package/directory, do not pre-generate files and functions. */
export async function enrichRepository(db: Db, root: string, config: LlmConfig): Promise<LlmRunStats> {
  const started = Date.now();
  const stats: LlmRunStats = {
    enabled: config.enabled,
    available: false,
    model: config.model,
    generated: 0,
    cacheHits: 0,
    failures: 0,
    durationMs: 0,
    ...emptyUsage(),
  };

  setMeta(db, "llm_output_language", config.outputLanguage);

  // Cache validity is determined only by the structure fingerprint and is unrelated to whether there is a key this time. First, clear the expired content,
  // Otherwise, after scanning offline, the UI will still show the old explanations that are inconsistent with the source code.
  const repoHash = repositoryHash(db);
  const architecture = architectureInput(db);
  const architectureHash = digest([repoHash, architecture, config.outputLanguage, config.model]);
  const cachedRepo = getCachedSemantic(
    db, "repo", ".", "summary", config.outputLanguage, repoHash, config.model,
  );
  const cachedLayers = layersAreFresh(db, architectureHash);
  const targets = semanticTargets(db);
  const missing: SemanticTarget[] = [];
  transact(db, () => {
    invalidateCachedSemantic(db, "repo", ".", repoHash);
    if (!cachedLayers) db.prepare("DELETE FROM layers").run();
    for (const target of targets) {
      const cached = getCachedSemantic(
        db, target.kind, target.key, "summary", config.outputLanguage, target.hash, config.model,
      );
      if (cached) stats.cacheHits++;
      else {
        invalidateCachedSemantic(db, target.kind, target.key, target.hash);
        missing.push(target);
      }
    }
  });
  if (cachedRepo) stats.cacheHits++;
  if (cachedLayers) stats.cacheHits++;

  if (!config.enabled) {
    stats.reason = "LLM 已关闭，使用纯结构模式";
    finishScanStatus(db, stats, started, config.interactiveModel);
    return stats;
  }

  let client: OpenAiCompatibleClient;
  try {
    client = new OpenAiCompatibleClient(config);
    stats.available = true;
  } catch (err) {
    stats.reason = safeMessage(err);
    finishScanStatus(db, stats, started, config.interactiveModel);
    return stats;
  }

  let remainingCalls = config.scanMaxCalls;
  const jobs: Array<() => Promise<void>> = [];

  if ((!cachedRepo || !cachedLayers) && remainingCalls > 0) {
    remainingCalls--;
    jobs.push(async () => {
      try {
        const result = await client.completeJson<ArchitectureResponse>(
          architectureSystem(config.outputLanguage),
          JSON.stringify({
            repository: repositoryContext(db),
            allowedNodes: withCachedSummaries(db, architecture.nodes, config.outputLanguage),
            dependencies: architecture.dependencies.slice(0, MAX_ARCHITECTURE_DEPENDENCIES),
          }),
        );
        addUsage(stats, result.usage);
        const summary = cleanText(result.data.summary, 2_000);
        const layers = cleanLayers(result.data.layers, new Set(architecture.nodes.map((n) => n.id)));
        transact(db, () => {
          if (summary !== null) {
            putCachedSemantic(db, {
              targetKind: "repo",
              targetKey: ".",
              flavor: "summary",
              lang: config.outputLanguage,
              content: summary,
              sourceHash: repoHash,
              model: config.model,
            });
            stats.generated++;
          }
          if (layers.length > 0) {
            db.prepare("DELETE FROM layers").run();
            const insert = db.prepare(
              `INSERT INTO layers (name, description, ordinal, members, source_hash, model, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const [ordinal, layer] of layers.entries()) {
              insert.run(
                layer.name,
                layer.description,
                ordinal,
                JSON.stringify(layer.nodeIds),
                architectureHash,
                config.model,
                new Date().toISOString(),
              );
            }
            stats.generated += layers.length;
          }
        });
      } catch (err) {
        stats.failures++;
        stats.reason ??= safeMessage(err);
      }
    });
  }

  // Try to cover all targets while adhering to scanMaxCalls; very large warehouses will automatically increase the batch size.
  const batchSize = Math.min(
    20,
    Math.max(config.scanBatchSize, Math.ceil(missing.length / Math.max(1, remainingCalls))),
  );
  for (let start = 0; start < missing.length && remainingCalls > 0; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    remainingCalls--;
    jobs.push(async () => {
      try {
        const result = await client.completeJson<BatchResponse>(
          summarySystem(config.outputLanguage),
          JSON.stringify({ items: batch.map((item) => ({ key: item.key, ...item.context })) }),
        );
        addUsage(stats, result.usage);
        const byKey = new Map(
          (result.data.items ?? [])
            .map((item) => [typeof item.key === "string" ? item.key : "", cleanText(item.summary, 600)] as const)
            .filter((entry): entry is readonly [string, string] => entry[0] !== "" && entry[1] !== null),
        );
        transact(db, () => {
          for (const target of batch) {
            const summary = byKey.get(target.key);
            if (!summary) continue;
            putCachedSemantic(db, {
              targetKind: target.kind,
              targetKey: target.key,
              flavor: "summary",
              lang: config.outputLanguage,
              content: summary,
              sourceHash: target.hash,
              model: config.model,
            });
            stats.generated++;
          }
        });
      } catch (err) {
        stats.failures++;
        stats.reason ??= safeMessage(err);
      }
    });
  }

  await Promise.all(jobs.map((job) => job()));
  if (jobs.length > 0 && stats.failures === jobs.length) {
    stats.available = false;
  }
  finishScanStatus(db, stats, started, config.interactiveModel);
  return stats;
}

/** Details drawer trigger: Generate the summary and pseudocode at the same time, and cache them according to the symbol source code hash. */
export async function generateSymbolSemantics(
  db: Db,
  root: string,
  symbolId: number,
  options: { force?: boolean } = {},
): Promise<SemanticResultDto> {
  const force = options.force === true;
  const key = `${root}:symbol:${symbolId}:${force ? "force" : "cached"}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = generateSymbolSemanticsInner(db, root, symbolId, force).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function generateSymbolSemanticsInner(
  db: Db,
  root: string,
  symbolId: number,
  force: boolean,
): Promise<SemanticResultDto> {
  const config = loadConfig(root).llm;
  const row = db
    .prepare(
      `SELECT s.name, s.kind, s.container, s.signature, s.doc, s.hash,
              s.start_line AS startLine, s.end_line AS endLine,
              f.path AS filePath, f.language
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    )
    .get(symbolId) as
    | {
        name: string; kind: string; container: string | null; signature: string | null;
        doc: string | null; hash: string;
        startLine: number; endLine: number; filePath: string; language: string;
      }
    | undefined;
  if (!row) throw new Error("符号不存在");

  const targetKey = symbolKey(row.filePath, row.container, row.name, row.startLine);
  const lang = config.outputLanguage;
  const requestConfig = interactiveConfig(config);
  const summary = getCachedSemantic(
    db, "symbol", targetKey, "summary-v2", lang, row.hash, requestConfig.model,
  );
  const pseudocode = getCachedSemantic(
    db, "symbol", targetKey, "pseudocode", lang, row.hash, requestConfig.model,
  );
  const shortSummary = getCachedSemantic(
    db, "symbol", targetKey, "tooltip-summary", lang, row.hash, requestConfig.model,
  );
  if (!force && summary && shortSummary && pseudocode) {
    return {
      summary: summary.content,
      shortSummary: shortSummary.content,
      pseudocode: pseudocode.content,
      pseudocodeSteps: cachedPseudocodeSteps(
        db, "symbol", targetKey, lang, row.hash, requestConfig.model, pseudocode.content,
      ),
      generated: false,
      cacheHit: true,
      model: summary.model,
      usage: emptyUsage(),
    };
  }

  const client = new OpenAiCompatibleClient(requestConfig);
  const source = numberSourceLines(
    readSymbolSource(root, row.filePath, row.startLine, row.endLine), row.startLine, 48_000,
  );
  const relations = symbolRelations(db, symbolId);
  const result = await client.completeJson<SymbolSemanticResponse>(
    symbolSystem(config.outputLanguage),
    JSON.stringify({
      symbol: {
        name: row.container ? `${row.container}.${row.name}` : row.name,
        kind: row.kind,
        language: row.language,
        file: row.filePath,
        lines: [row.startLine, row.endLine],
        signature: row.signature,
        documentation: row.doc,
        callers: relations.callers,
        callees: relations.callees,
        source,
      },
    }),
    { maxOutputTokens: 1_200 },
  );
  const generatedSummary = normalizeSummary(result.data.summary, 2_000, config.outputLanguage);
  const generatedShortSummary = cleanSingleLine(result.data.shortSummary, 240);
  const generatedSteps = normalizePseudocodeSteps(
    result.data.pseudocode, { from: row.startLine, to: row.endLine }, 12,
  );
  if (generatedSummary === null || generatedShortSummary === null || generatedSteps === null) {
    throw new Error("LLM 返回缺少 summary、shortSummary 或 pseudocode");
  }
  const generatedPseudocode = pseudocodeStepsToText(generatedSteps).slice(0, 8_000);

  transact(db, () => {
    invalidateCachedSemantic(db, "symbol", targetKey, row.hash);
    for (const [flavor, content] of [
      ["summary-v2", generatedSummary],
      ["tooltip-summary", generatedShortSummary],
      ["pseudocode", generatedPseudocode],
      ["pseudocode-map", JSON.stringify(generatedSteps)],
    ] as const) {
      putCachedSemantic(db, {
        targetKind: "symbol",
        targetKey,
        flavor,
        lang,
        content,
        sourceHash: row.hash,
        model: requestConfig.model,
      });
    }
    mergeLlmStatusUsage(db, {
      enabled: true,
      available: true,
      model: config.model,
      interactiveModel: config.interactiveModel,
      reason: null,
      usage: result.usage,
    });
  });

  return {
    summary: generatedSummary,
    shortSummary: generatedShortSummary,
    pseudocode: generatedPseudocode,
    pseudocodeSteps: generatedSteps,
    generated: true,
    cacheHit: false,
    model: requestConfig.model,
    usage: result.usage,
  };
}

/** File summaries are likewise on-demand, ensuring that during the scanning period there are only package/directory-level requests. */
export async function generateFileSummary(
  db: Db,
  root: string,
  fileId: number,
  options: { force?: boolean } = {},
): Promise<SemanticResultDto> {
  const force = options.force === true;
  const key = `${root}:file:${fileId}:${force ? "force" : "cached"}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = generateFileSummaryInner(db, root, fileId, force).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function generateFileSummaryInner(
  db: Db, root: string, fileId: number, force: boolean,
): Promise<SemanticResultDto> {
  const config = loadConfig(root).llm;
  const row = db.prepare("SELECT path, language, hash, bytes FROM files WHERE id = ?").get(fileId) as
    | { path: string; language: string; hash: string; bytes: number }
    | undefined;
  if (!row) throw new Error("文件不存在");

  // An empty file has no semantic content for the model to generalize. You must short-circuit before creating the client, otherwise even
  // There is no content, but it will first verify the API Key, and then send a request that is destined to be meaningless.
  // bytes handle actual zero-byte files; after reading, trim also overwrites files that contain only newlines/spaces.
  const fileContent = row.bytes === 0 ? "" : readFileForSemantics(root, row.path);
  if (fileContent.trim() === "") {
    return {
      summary: null, shortSummary: null, pseudocode: null, skipReason: "empty-file",
      generated: false, cacheHit: false, model: interactiveConfig(config).model, usage: emptyUsage(),
    };
  }

  const summary = getCachedSemantic(
    db, "file", row.path, "summary-v2", config.outputLanguage, row.hash,
    interactiveConfig(config).model,
  );
  const shortSummary = getCachedSemantic(
    db, "file", row.path, "tooltip-summary", config.outputLanguage, row.hash,
    interactiveConfig(config).model,
  );
  const pseudocode = getCachedSemantic(
    db, "file", row.path, "pseudocode", config.outputLanguage, row.hash,
    interactiveConfig(config).model,
  );
  if (!force && summary && shortSummary && pseudocode) {
    return {
      summary: summary.content, shortSummary: shortSummary.content, pseudocode: pseudocode.content,
      pseudocodeSteps: cachedPseudocodeSteps(
        db, "file", row.path, config.outputLanguage, row.hash,
        interactiveConfig(config).model, pseudocode.content,
      ),
      generated: false, cacheHit: true, model: summary.model, usage: emptyUsage(),
    };
  }

  const requestConfig = interactiveConfig(config);
  const client = new OpenAiCompatibleClient(requestConfig);
  const symbols = db.prepare(
    `SELECT name, kind, container, exported, signature, doc,
            start_line AS startLine, end_line AS endLine
     FROM symbols WHERE file_id = ? ORDER BY start_line LIMIT 80`,
  ).all(fileId);
  const imports = db.prepare(
    "SELECT raw_source AS source, line FROM imports WHERE file_id = ? ORDER BY line LIMIT 80",
  ).all(fileId);
  const calls = db.prepare(
    `SELECT caller.name AS caller, caller.container AS callerContainer,
            callee.name AS callee, callee.container AS calleeContainer,
            e.line, e.confidence
     FROM edges e
     JOIN symbols caller ON e.src_kind = 'symbol' AND caller.id = e.src_id
     JOIN symbols callee ON e.dst_kind = 'symbol' AND callee.id = e.dst_id
     WHERE e.type = 'calls' AND caller.file_id = ? AND callee.file_id = ?
     ORDER BY e.line LIMIT 160`,
  ).all(fileId, fileId);
  const source = numberSourceLines(fileContent, 1, 28_000);
  const result = await client.completeJson<FileSemanticResponse>(
    fileSystem(config.outputLanguage),
    JSON.stringify({ file: { path: row.path, language: row.language, symbols, imports, calls, source } }),
    { maxOutputTokens: 1_200 },
  );
  const generatedSummary = normalizeSummary(result.data.summary, 2_000, config.outputLanguage);
  const generatedShortSummary = cleanSingleLine(result.data.shortSummary, 240);
  const generatedSteps = normalizePseudocodeSteps(
    result.data.pseudocode, { from: 1, to: fileContent.split("\n").length }, 24,
  );
  if (generatedSummary === null || generatedShortSummary === null || generatedSteps === null) {
    throw new Error("LLM 返回缺少 summary、shortSummary 或 pseudocode");
  }
  const generatedPseudocode = pseudocodeStepsToText(generatedSteps).slice(0, 12_000);
  transact(db, () => {
    invalidateCachedSemantic(db, "file", row.path, row.hash);
    for (const [flavor, content] of [
      ["summary-v2", generatedSummary],
      ["tooltip-summary", generatedShortSummary],
      ["pseudocode", generatedPseudocode],
      ["pseudocode-map", JSON.stringify(generatedSteps)],
    ] as const) {
      putCachedSemantic(db, {
        targetKind: "file", targetKey: row.path, flavor, lang: config.outputLanguage,
        content, sourceHash: row.hash, model: requestConfig.model,
      });
    }
    mergeLlmStatusUsage(db, {
      enabled: true, available: true, model: config.model,
      interactiveModel: config.interactiveModel, reason: null, usage: result.usage,
    });
  });
  return {
    summary: generatedSummary, shortSummary: generatedShortSummary, pseudocode: generatedPseudocode,
    pseudocodeSteps: generatedSteps,
    generated: true, cacheHit: false, model: requestConfig.model, usage: result.usage,
  };
}

function cachedPseudocodeSteps(
  db: Db,
  targetKind: SemanticTargetKind,
  targetKey: string,
  lang: string,
  sourceHash: string,
  model: string,
  text: string,
): PseudocodeStepDto[] | null {
  const mapped = getCachedSemantic(db, targetKind, targetKey, "pseudocode-map", lang, sourceHash, model);
  return (mapped ? parsePseudocodeSteps(mapped.content) : null) ?? parsePseudocodeText(text);
}

function semanticTargets(db: Db): SemanticTarget[] {
  const packages = db.prepare(
    `SELECT p.name, p.dir, p.manager, COUNT(f.id) AS files, COALESCE(SUM(f.loc), 0) AS loc
     FROM packages p LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
     GROUP BY p.id HAVING files > 0 ORDER BY loc DESC`,
  ).all() as Array<{ name: string; dir: string; manager: string; files: number; loc: number }>;
  const packageTargets = packages.map((row): SemanticTarget => {
    const fileRows = filesUnder(db, row.dir, 30);
    return {
      kind: "package", key: row.name, nodeId: `pkg:${row.name}`,
      hash: targetHash(db, row.dir),
      context: { kind: "package", path: row.dir, manager: row.manager, files: row.files, loc: row.loc, examples: fileRows },
    };
  });

  const directories = db.prepare(
    `SELECT d.path, d.loc, d.file_count AS files, d.symbol_count AS symbols
     FROM directories d
     WHERE EXISTS (SELECT 1 FROM files f WHERE f.role = 'source' AND (f.dir_path = d.path OR f.path LIKE d.path || '/%'))
     ORDER BY d.loc DESC`,
  ).all() as Array<{ path: string; loc: number; files: number; symbols: number }>;
  const directoryTargets = directories.map((row): SemanticTarget => ({
    kind: "directory", key: row.path, nodeId: `dir:${row.path}`,
    hash: targetHash(db, row.path),
    context: { kind: "directory", path: row.path, files: row.files, loc: row.loc, symbols: row.symbols, examples: filesUnder(db, row.path, 20) },
  }));
  return [...packageTargets, ...directoryTargets];
}

function filesUnder(db: Db, dir: string, limit: number): unknown[] {
  const root = dir === ".";
  return db.prepare(
    `SELECT f.path, f.language, f.loc,
            (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT s.name FROM symbols s WHERE s.file_id = f.id ORDER BY s.exported DESC, s.start_line LIMIT 8)) AS symbols
     FROM files f WHERE f.role = 'source' AND ${root ? "1 = 1" : "(f.dir_path = ? OR f.path LIKE ? || '/%')"}
     ORDER BY f.loc DESC LIMIT ?`,
  ).all(...(root ? [limit] : [dir, dir, limit]));
}

function targetHash(db: Db, dir: string): string {
  const root = dir === ".";
  const rows = db.prepare(
    `SELECT path, hash FROM files WHERE role = 'source' AND ${root ? "1 = 1" : "(dir_path = ? OR path LIKE ? || '/%')"} ORDER BY path`,
  ).all(...(root ? [] : [dir, dir])) as Array<{ path: string; hash: string }>;
  return digest(rows);
}

function repositoryHash(db: Db): string {
  return targetHash(db, ".");
}

function repositoryContext(db: Db): Record<string, unknown> {
  const totals = db.prepare(
    "SELECT COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc FROM files WHERE role = 'source'",
  ).get();
  const languages = db.prepare(
    "SELECT language, COUNT(*) AS files, SUM(loc) AS loc FROM files WHERE role = 'source' GROUP BY language ORDER BY loc DESC",
  ).all();
  const packages = db.prepare(
    `SELECT p.name, p.dir, COUNT(f.id) AS files, COALESCE(SUM(f.loc), 0) AS loc
     FROM packages p LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source' GROUP BY p.id ORDER BY loc DESC`,
  ).all();
  return { name: getMeta(db, "repo_name"), totals, languages, packages };
}

interface ArchitectureNode {
  id: string;
  label: string;
  path: string;
  files: number;
  loc: number;
  /** The most frequently called exported symbol: what is provided externally in this part */
  exports: string[];
  /** External libraries used: react for the interface, better-sqlite3 for storage, are the most direct evidence for determining responsibilities. */
  externals: string[];
  /** Supported entry types: http / cli / main / public-api */
  entries: string[];
}

type DependencyKind = "import" | "type" | "http";

interface ArchitectureInput {
  nodes: ArchitectureNode[];
  /** from dependency to: import is a runtime dependency, type only references types, http is the frontend requesting backend routes by URL */
  dependencies: Array<{ from: string; to: string; count: number; kind: DependencyKind }>;
}

/**
 * Layered input. When only giving the name and path, the model can only guess based on the directory name; here it can indicate responsibilities and
 * Provide it with definitive evidence of relative positions: which modules depend on which, and which external libraries each uses.
 * Which entry points it carries, and which functions it provides externally.
 */
function architectureInput(db: Db): ArchitectureInput {
  const candidates = architectureCandidates(db);
  const byId = new Map(candidates.map((c) => [c.id, { ...c, files: 0, loc: 0, exports: [] as string[], externals: [] as string[], entries: [] as string[] }]));
  const ownerOfFile = new Map<number, string>();
  const byPackage = new Map(candidates.flatMap((c) => (c.packageId === undefined ? [] : [[c.packageId, c.id] as const])));
  const byPath = candidates.filter((c) => c.packageId === undefined).sort((a, b) => b.path.length - a.path.length);

  for (const file of db.prepare("SELECT id, path, loc, package_id AS packageId FROM files WHERE role = 'source'").all() as Array<{
    id: number; path: string; loc: number; packageId: number | null;
  }>) {
    const owner = byPackage.size > 0
      ? (file.packageId === null ? undefined : byPackage.get(file.packageId))
      : byPath.find((c) => file.path.startsWith(`${c.path}/`))?.id;
    if (owner === undefined) continue;
    ownerOfFile.set(file.id, owner);
    const node = byId.get(owner)!;
    node.files++;
    node.loc += file.loc;
  }

  const deps = new Map<string, ArchitectureInput["dependencies"][number]>();
  const externals = new Map<string, Map<string, number>>();
  for (const edge of db.prepare(
    `SELECT src_id AS src, dst_id AS dst, dst_kind AS dstKind, dst_name AS name, type, weight FROM edges
     WHERE src_kind = 'file' AND ((dst_kind = 'file' AND type IN ('imports', 'references', 'http')) OR dst_kind = 'external')`,
  ).all() as Array<{ src: number; dst: number | null; dstKind: string; name: string | null; type: string; weight: number }>) {
    const from = ownerOfFile.get(edge.src);
    if (from === undefined) continue;
    if (edge.dstKind === "external") {
      if (edge.name === null) continue;
      const counts = externals.get(from) ?? new Map<string, number>();
      counts.set(edge.name, (counts.get(edge.name) ?? 0) + edge.weight);
      externals.set(from, counts);
      continue;
    }
    const to = edge.dst === null ? undefined : ownerOfFile.get(edge.dst);
    if (to === undefined || to === from) continue;
    const kind: DependencyKind = edge.type === "references" ? "type" : edge.type === "http" ? "http" : "import";
    const key = `${from}\u0000${to}\u0000${kind}`;
    const existing = deps.get(key);
    if (existing) existing.count += edge.weight;
    else deps.set(key, { from, to, count: edge.weight, kind });
  }
  for (const [id, counts] of externals) {
    byId.get(id)!.externals = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);
  }

  for (const entry of db.prepare("SELECT DISTINCT file_id AS fileId, kind FROM entry_points WHERE kind != 'test'").all() as Array<{ fileId: number; kind: string }>) {
    const owner = ownerOfFile.get(entry.fileId);
    const node = owner === undefined ? undefined : byId.get(owner);
    if (node && !node.entries.includes(entry.kind)) node.entries.push(entry.kind);
  }

  for (const symbol of db.prepare(
    `SELECT s.name, s.file_id AS fileId, COUNT(e.id) AS callers FROM symbols s
     LEFT JOIN edges e ON e.type = 'calls' AND e.dst_kind = 'symbol' AND e.dst_id = s.id
     WHERE s.exported = 1 GROUP BY s.id ORDER BY callers DESC, s.name`,
  ).all() as Array<{ name: string; fileId: number }>) {
    const owner = ownerOfFile.get(symbol.fileId);
    const node = owner === undefined ? undefined : byId.get(owner);
    if (node && node.exports.length < 8 && !node.exports.includes(symbol.name)) node.exports.push(symbol.name);
  }

  return {
    nodes: [...byId.values()].map(({ packageId: _packageId, ...node }) => node),
    dependencies: [...deps.values()].sort((a, b) => b.count - a.count),
  };
}

/** Layered candidate modules and dependency locks, as well as inter-module dependency checks, are on the same layer, see architectureModules */
function architectureCandidates(db: Db): Array<{ id: string; label: string; path: string; packageId?: number }> {
  return architectureModules(db);
}

/** Summaries of existing packages/directories are only put into prompts, not cached fingerprints: they are generated one round later, and including them would make every scan recalculate layering unnecessarily. */
function withCachedSummaries(db: Db, nodes: readonly ArchitectureNode[], lang: string): Array<ArchitectureNode & { summary?: string }> {
  const lookup = db.prepare(
    `SELECT content FROM summaries WHERE target_kind = ? AND target_key = ? AND flavor = 'summary' AND lang = ?
     ORDER BY created_at DESC LIMIT 1`,
  );
  return nodes.map((node) => {
    const kind = node.id.startsWith("pkg:") ? "package" : "directory";
    const key = node.id.startsWith("pkg:") ? node.label : node.path;
    const row = lookup.get(kind, key, lang) as { content: string } | undefined;
    return row ? { ...node, summary: row.content } : node;
  });
}

function layersAreFresh(db: Db, hash: string): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n, MIN(source_hash = ?) AS fresh FROM layers").get(hash) as { n: number; fresh: number | null };
  return row.n > 0 && row.fresh === 1;
}

function symbolRelations(db: Db, symbolId: number): { callers: string[]; callees: string[] } {
  const query = (direction: "callers" | "callees") =>
    (db.prepare(direction === "callers"
      ? `SELECT s.name, f.path FROM edges e JOIN symbols s ON s.id = e.src_id JOIN files f ON f.id = s.file_id
         WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol' AND e.dst_id = ? LIMIT 30`
      : `SELECT s.name, f.path FROM edges e JOIN symbols s ON s.id = e.dst_id JOIN files f ON f.id = s.file_id
         WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol' AND e.src_id = ? LIMIT 30`)
      .all(symbolId) as Array<{ name: string; path: string }>).map((row) => `${row.name} (${row.path})`);
  return { callers: query("callers"), callees: query("callees") };
}

/**
 * Take the whole line by line number, not by slicing with start_byte: those two columns come from web-tree-sitter
 * startIndex is the JS string index on the parsed text, not a UTF-8 byte; Vue/Svelte
 * It's still virtual text after being masked. Only line numbers are reliable in any file.
 */
function readSymbolSource(root: string, path: string, startLine: number, endLine: number): string {
  try {
    return readFileSync(join(root, path), "utf8").split("\n").slice(startLine - 1, endLine).join("\n");
  } catch {
    return "";
  }
}

function readFileForSemantics(root: string, path: string): string {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取文件 ${path}：${detail}`);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanLayers(
  input: ArchitectureResponse["layers"],
  allowed: ReadonlySet<string>,
): Array<{ name: string; description: string; nodeIds: string[] }> {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Array<{ name: string; description: string; nodeIds: string[] }> = [];
  for (const raw of input.slice(0, 12)) {
    const name = cleanText(raw.name, 80);
    if (!name || seen.has(name)) continue;
    const nodeIds = Array.isArray(raw.nodeIds)
      ? [...new Set(raw.nodeIds.filter((id): id is string => typeof id === "string" && allowed.has(id)))]
      : [];
    if (nodeIds.length === 0) continue;
    seen.add(name);
    out.push({ name, description: cleanText(raw.description, 400) ?? "", nodeIds });
  }
  return out;
}

function finishScanStatus(
  db: Db,
  stats: LlmRunStats,
  started: number,
  interactiveModel: string | null,
): void {
  stats.durationMs = Date.now() - started;
  mergeLlmStatusUsage(db, {
    enabled: stats.enabled, available: stats.available, model: stats.model,
    interactiveModel,
    reason: stats.reason ?? null,
    usage: { requests: stats.requests, inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, totalTokens: stats.totalTokens },
  });
}

function safeMessage(error: unknown): string {
  if (error instanceof LlmUnavailableError || error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function interactiveConfig(config: LlmConfig): LlmConfig {
  return {
    ...config,
    ...(config.interactiveModel === null ? {} : { model: config.interactiveModel }),
    // File/function explanations need to be stable rather than creative. The structure is still enforced to be uniform by the post-processor, with a temperature of 0.
    // This minimizes the probability of significant deviations in wording and step order after the user manually refreshes.
    temperature: 0,
  };
}

function languageName(lang: "zh" | "en"): string {
  return lang === "zh" ? "简体中文" : "English";
}

function architectureSystem(lang: "zh" | "en"): string {
  return `你是代码架构分析器。只依据输入的确定性结构数据归纳语义，不得编造调用关系。用${languageName(lang)}输出。` +
    `allowedNodes 是候选模块：exports 是被调用最多的导出符号，externals 是它用到的外部库，entries 是它承载的入口` +
    `（http 路由、cli 命令、main、public-api），summary 是已有的一句话说明（可能缺失）。` +
    `dependencies 是模块之间的依赖，from 依赖 to，count 是引用次数；kind 为 import 是运行时依赖，` +
    `type 只引用类型、不构成运行时依赖，http 是 from 按 URL 请求 to 里的后端路由（前端在上、后端在下）。` +
    `按依赖方向分层：承载入口或界面、很少被别人依赖的在上层，被多数模块依赖而自身少依赖的在下层；` +
    `layers 按从上到下的顺序排列。层名说明职责，不要照抄目录名。` +
    `只返回 JSON：{"summary":"仓库概览（2-4句）","layers":[{"name":"层名","description":"一句说明","nodeIds":["只能来自 allowedNodes.id"]}]}。` +
    `每个节点最多属于一个主层；无法判断的节点可不分层。`;
}

function summarySystem(lang: "zh" | "en"): string {
  return `你是代码仓库摘要器。根据路径、语言、指标和代表性符号，为每个包或目录写一句准确说明。用${languageName(lang)}输出。` +
    `不得推断输入中没有的业务事实。只返回 JSON：{"items":[{"key":"原样复制输入 key","summary":"一句话"}]}。`;
}

function symbolSystem(lang: "zh" | "en"): string {
  return `你是代码解释器。只根据给定源码、签名和确定性调用关系解释符号。用${languageName(lang)}输出。` +
    readableSummaryInstructions(lang, false) +
    `shortSummary 必须是一句不带标题的通俗用途说明，供悬停卡片快速阅读，不超过 80 个汉字或 160 个英文字符。` +
    `伪代码最多 12 行，每行尽量不超过 72 个显示字符并保持层级缩进；` +
    `不要复述语法，要呈现分支、循环、错误处理、输入输出；不得声称源码被截断。` +
    semanticJsonContract();
}

function fileSystem(lang: "zh" | "en"): string {
  return `你是代码文件摘要器。只根据给定源码、导入和符号列表解释文件。用${languageName(lang)}输出。` +
    readableSummaryInstructions(lang, true) +
    `shortSummary 必须是一句不带标题的通俗用途说明，供悬停卡片快速阅读，不超过 80 个汉字或 160 个英文字符。` +
    `pseudocode 要从文件整体出发，按源码中的组织或执行顺序列出主要导出、初始化步骤、关键函数及函数间的调用关系，` +
    `让读者不打开源码也能理解“文件里有哪些主要逻辑、它们怎样协作”；不要逐行翻译，也不要虚构执行顺序。` +
    `文件只有类型或常量时，应如实描述声明与导出关系。伪代码控制在 24 行内，` +
    `每行尽量不超过 72 个显示字符，较长步骤拆成带缩进的子步骤。` +
    `不得编造源码中没有的业务用途、运行效果或约束。` +
    semanticJsonContract();
}

function readableSummaryInstructions(lang: "zh" | "en", requireConcepts: boolean): string {
  const structure = lang === "zh"
    ? `summary 使用固定字段：purpose 只用日常语言说明用途，不要写“为什么需要”或“如何实现”标题；` +
      `keyConcepts 用字符串数组解释 1-4 个“术语（通俗解释）”；` +
      `workflow 用字符串数组按顺序说明关键输入、输出和流程；notes 只放重要限制、替代实现或易错边界，没有则为空数组。`
    : `Use fixed summary fields: purpose explains the use in plain language; keyConcepts is an array of 1-4 ` +
      `"term (plain explanation)" strings; workflow is an ordered array of key inputs, outputs, and flow; ` +
      `notes contains only meaningful constraints, alternatives, or pitfalls, otherwise an empty array.`;
  if (lang === "en") {
    return `Write for developers who can code but are unfamiliar with this domain. ${structure}` +
      `Explain why it is needed before how it is implemented. Do not list every export or pack concepts into one long sentence. ` +
      `Do not begin with unexplained jargon; define every specialized term in parentheses at its first use. ` +
      `Derive every claim from the input, not from general knowledge of the domain. Do not imply timing, persistence, ` +
      `network reporting, runtime validation, or other behavior unless the source explicitly implements it. ` +
      (requireConcepts
        ? `Keep the Key concepts paragraph; if there is little domain jargon, explain the most important code concept. `
        : `For a simple symbol with no domain jargon, the Key concepts paragraph may be omitted. `);
  }
  return `面向会写代码、但不了解当前领域的开发者。${structure}` +
    `先讲“为什么需要”，再讲“如何实现”；不要罗列全部导出名，也不要用一句长句堆砌概念。` +
    `第一段不要直接使用未解释的专业术语；任何专业术语首次出现时都要紧跟括号解释。` +
    `每项结论都必须来自输入，不能套用该领域的一般知识。除非源码明确实现，否则不要暗示耗时统计、` +
    `持久化、网络上报、运行时校验或其他能力。` +
    (requireConcepts
      ? `必须保留核心概念段；如果几乎没有领域术语，就解释最关键的代码概念。`
      : `符号很简单且没有领域术语时，可以省略核心概念段。`);
}

function semanticJsonContract(): string {
  return `只返回以下结构的 JSON，不要使用 Markdown，不要在字符串里写 \\n 或 \\r\\n：` +
    `{"summary":{"purpose":"用途","keyConcepts":["术语（解释）"],` +
    `"workflow":["步骤"],"notes":["提示"]},` +
    `"shortSummary":"一句话用途",` +
    `"pseudocode":[{"step":"顶层步骤","lines":[起始行,结束行],` +
    `"details":[{"text":"子步骤","lines":[起始行,结束行]}]}]}。` +
    `source 每行开头的「行号| 」是该行在文件中的绝对行号，不属于代码本身；` +
    `以「…（省略 N 字符）」结尾的行过长（多为 base64、压缩代码或内联数据），只保留了开头，这不是源码被截断；` +
    `lines 用这些行号标出该步骤对应源码的起止行（闭区间），子步骤的范围应落在所属步骤之内；` +
    `无法对应到具体代码时省略 lines，不要猜测。` +
    `数组顺序必须遵循源码组织或执行顺序；没有内容时返回空数组，不得更换字段名。`;
}
