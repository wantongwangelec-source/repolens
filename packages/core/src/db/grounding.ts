import type { GroundingDto } from "../types.js";
import type { Db } from "./database.js";

const CODE_SPAN = /`([^`\n]{1,160})`/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const PATH_LIKE = /^[\w@.-]+(?:\/[\w@.-]+)+$|^[\w@.-]+\.[A-Za-z0-9]{1,6}$/;
const PACKAGE_LIKE = /^@?[\w.-]+(?:\/[\w.-]+)?$/;

export interface GroundingContext {
  /** The summary refers to which document; the name should be looked for here first */
  fileId?: number | undefined;
  /** The directory of the package; next, look here */
  packageDir?: string | null | undefined;
  /**
   * The original source code on which the summary is based. Only then is it judged as a 'made-up name': it never appears in the source code, nor can it be found in the index.
   * The package and directory summaries do not have a specific original text to compare, only links, no determination of missing parts.
   */
  source?: string | undefined;
}

/**
 * The name enclosed in backticks in the AI text corresponds to which node in the code. If it matches, you can click through on the interface;
 * Marked as missing when it never appeared in the source code or the index — the thing the model is talking about is most likely made up.
 * Fragments that are not code names (phrases with spaces, numbers) are not processed.
 */
export function groundText(db: Db, text: string | null | undefined, context: GroundingContext = {}): GroundingDto[] | null {
  if (!text) return null;
  const tokens = [...new Set([...text.matchAll(CODE_SPAN)].map((match) => match[1]!.trim()))];
  if (tokens.length === 0) return null;

  const fileByPath = db.prepare("SELECT id FROM files WHERE path = ?");
  const fileBySuffix = db.prepare("SELECT id FROM files WHERE path LIKE ? ORDER BY length(path) LIMIT 2");
  const packageByName = db.prepare("SELECT name FROM packages WHERE name = ?");
  const symbolsByName = db.prepare(
    `SELECT s.id, s.file_id AS fileId, f.path, s.exported FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.name = ? AND (? IS NULL OR s.container = ?) LIMIT 50`,
  );

  const out: GroundingDto[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/\(\s*\)$/, "").replace(/\(.*\)$/, "");
    if (token === "" || /\s/.test(token) || /^\d/.test(token)) continue;

    let nodeId: string | null = null;
    if (PATH_LIKE.test(token) && token.includes(".") && !IDENTIFIER.test(token)) {
      const exact = fileByPath.get(token) as { id: number } | undefined;
      const suffix = exact ? [] : (fileBySuffix.all(`%/${token}`) as Array<{ id: number }>);
      const hit = exact ?? (suffix.length === 1 ? suffix[0] : undefined);
      if (hit) nodeId = `file:${hit.id}`;
    }
    if (nodeId === null && PACKAGE_LIKE.test(token) && packageByName.get(token)) nodeId = `pkg:${token}`;
    if (nodeId === null && IDENTIFIER.test(token)) {
      const parts = token.split(".");
      const name = parts.at(-1)!;
      const container = parts.length > 1 ? parts.slice(0, -1).join(".") : null;
      const rows = symbolsByName.all(name, container, container) as Array<{ id: number; fileId: number; path: string; exported: number }>;
      const pick =
        rows.find((r) => r.fileId === context.fileId) ??
        (context.packageDir ? only(rows.filter((r) => context.packageDir === "." || r.path.startsWith(`${context.packageDir}/`))) : undefined) ??
        only(rows.filter((r) => r.exported === 1)) ??
        only(rows);
      if (pick) nodeId = `sym:${pick.id}`;
    }

    const missing = nodeId === null && context.source !== undefined && !mentioned(context.source, token);
    if (nodeId !== null || missing) out.push({ text: raw, nodeId, missing });
  }
  return out.length > 0 ? out : null;
}

function only<T>(rows: readonly T[]): T | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

/** This name has appeared in the source code (attribute names, literals, and local variables all count) */
function mentioned(source: string, token: string): boolean {
  const last = token.split(/[./]/).filter(Boolean).at(-1) ?? token;
  const escaped = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(source);
}
