/**
 * Access to AI-generated content: the summaries table, as well as the output language and AI status recorded in the meta.
 * The content is standardized into the same format when written and read, and even the old cache is read out in the new format.
 */

import type { LlmUsage } from "../types.js";
import { getMeta, getMetaJson, setMetaJson, type Db } from "./database.js";
import { normalizeSemanticContent } from "./semantic-format.js";

export type SemanticTargetKind = "repo" | "package" | "directory" | "file" | "symbol";
export type SemanticFlavor =
  | "summary"
  | "summary-v2"
  | "tooltip-summary"
  | "pseudocode"
  | "pseudocode-map";

export interface CachedSemantic {
  content: string;
  model: string;
  sourceHash: string;
  createdAt: string;
}

export function getCachedSemantic(
  db: Db,
  targetKind: SemanticTargetKind,
  targetKey: string,
  flavor: SemanticFlavor,
  lang: string,
  sourceHash?: string,
  model?: string,
): CachedSemantic | null {
  const args: unknown[] = [targetKind, targetKey, flavor, lang];
  const hashClause = sourceHash === undefined ? "" : "AND source_hash = ?";
  if (sourceHash !== undefined) args.push(sourceHash);
  const modelClause = model === undefined ? "" : "AND model = ?";
  if (model !== undefined) args.push(model);
  const row = db
    .prepare(
      `SELECT content, model, source_hash AS sourceHash, created_at AS createdAt
       FROM summaries
       WHERE target_kind = ? AND target_key = ? AND flavor = ? AND lang = ? ${hashClause} ${modelClause}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...args) as CachedSemantic | undefined;
  return row === undefined
    ? null
    : { ...row, content: normalizeSemanticContent(row.content, flavor, lang === "en" ? "en" : "zh") };
}

export function putCachedSemantic(
  db: Db,
  input: {
    targetKind: SemanticTargetKind;
    targetKey: string;
    flavor: SemanticFlavor;
    lang: string;
    content: string;
    sourceHash: string;
    model: string;
  },
): void {
  const content = normalizeSemanticContent(
    input.content, input.flavor, input.lang === "en" ? "en" : "zh",
  );
  db.prepare(
    `INSERT INTO summaries
       (target_kind, target_key, flavor, lang, content, source_hash, model, created_at)
     VALUES (@targetKind, @targetKey, @flavor, @lang, @content, @sourceHash, @model, @createdAt)
     ON CONFLICT(target_kind, target_key, flavor, lang) DO UPDATE SET
       content = excluded.content, source_hash = excluded.source_hash,
       model = excluded.model, created_at = excluded.created_at`,
  ).run({ ...input, content, createdAt: new Date().toISOString() });
}

export function invalidateCachedSemantic(
  db: Db,
  targetKind: SemanticTargetKind,
  targetKey: string,
  sourceHash: string,
): void {
  db.prepare(
    "DELETE FROM summaries WHERE target_kind = ? AND target_key = ? AND source_hash != ?",
  ).run(targetKind, targetKey, sourceHash);
}

export function semanticLanguage(db: Db): string {
  return getMeta(db, "llm_output_language") ?? "zh";
}

export interface StoredLlmStatus {
  enabled: boolean;
  available: boolean;
  model: string;
  interactiveModel?: string | null;
  reason?: string | null;
  usage: LlmUsage;
}

export function readLlmStatus(db: Db): StoredLlmStatus | null {
  return getMetaJson<StoredLlmStatus | null>(db, "llm_status", null);
}

export function writeLlmStatus(db: Db, value: StoredLlmStatus): void {
  setMetaJson(db, "llm_status", value);
}
