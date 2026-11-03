import type { AnalyzableLanguage, Language } from "../types.js";
import { languageDefinition } from "../discovery/language.js";

export interface PreparedSource {
  /** Exactly matches the original file's UTF-8 byte count and line break positions, so the AST positions can be directly reused. */
  source: string;
  parserLanguage: Exclude<AnalyzableLanguage, "vue" | "svelte" | "astro">;
}

/**
 * Turn composite components into virtual JS/TS files of equal length: keep the script, template, style, and the tag itself
 * Replace with spaces, keep line breaks unchanged. This way, tree-sitter's line numbers and byte offsets still point to the original file.
 */
export function prepareSource(language: Language, source: string): PreparedSource | null {
  switch (languageDefinition(language)?.embedded) {
    case "vue":
    case "svelte":
      return scriptBlocks(source);
    case "astro":
      return astroFrontmatter(source);
    default:
      return null;
  }
}

function scriptBlocks(source: string): PreparedSource {
  const ranges: Array<{ start: number; end: number }> = [];
  let parserLanguage: PreparedSource["parserLanguage"] = "javascript";
  const tags = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

  for (const match of source.matchAll(tags)) {
    if (match.index === undefined) continue;
    const full = match[0];
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const bodyOffset = full.indexOf(">") + 1;
    const start = match.index + Math.max(0, bodyOffset);
    ranges.push({ start, end: start + body.length });

    const lang = attributeValue(attributes, "lang")?.toLowerCase();
    if (lang === "tsx" || lang === "jsx") parserLanguage = "tsx";
    else if ((lang === "ts" || lang === "typescript") && parserLanguage !== "tsx") {
      parserLanguage = "typescript";
    }
  }

  return { source: maskExcept(source, ranges), parserLanguage };
}

function astroFrontmatter(source: string): PreparedSource {
  // Astro frontmatter must start at the beginning of the file (BOM allowed) and end with a second line containing only ---.
  const open = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!open) return { source: maskExcept(source, []), parserLanguage: "typescript" };
  const bodyStart = open[0].length;
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(source.slice(bodyStart));
  const bodyEnd = close ? bodyStart + (close.index ?? 0) : source.length;
  return {
    source: maskExcept(source, [{ start: bodyStart, end: bodyEnd }]),
    parserLanguage: "typescript",
  };
}

function attributeValue(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/** UTF-8 byte-level masking to prevent Chinese templates from offsetting the startIndex of subsequent ASTs. */
function maskExcept(source: string, charRanges: readonly { start: number; end: number }[]): string {
  const input = Buffer.from(source, "utf8");
  const output = Buffer.alloc(input.length, 0x20);
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0x0a || input[i] === 0x0d) output[i] = input[i] as number;
  }
  for (const range of charRanges) {
    const start = Buffer.byteLength(source.slice(0, range.start), "utf8");
    const end = start + Buffer.byteLength(source.slice(range.start, range.end), "utf8");
    input.copy(output, start, start, end);
  }
  return output.toString("utf8");
}
