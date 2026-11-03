import type { CodeToken } from "../lib/highlight";

/** The upper limit when the parser stores signatures; if it's full, it indicates that the original text was truncated. */
export const MAX_SIGNATURE = 400;

/**
 * The range occupied by the declaration header in the source code: start from the symbol's starting line and go down until the text, after stripping the whitespace, covers the signature in the index.
 * The signatures stored in the index are compressed into a single line (see core's signatureOf); returning to the original text is necessary to preserve the author's line breaks and indentation.
 * The number of lines taken by the header, and the column position where the last line is left (followed by the function body); null if not found.
 */
export function declarationHeader(
  lines: readonly string[],
  signature: string,
  maxLines = 40,
): { count: number; lastColumn: number } | null {
  if (signature === "") return null;
  for (let count = 1; count <= Math.min(lines.length, maxLines); count++) {
    const text = lines.slice(0, count).join("\n");
    const at = normalizeWhitespace(text).indexOf(signature);
    if (at < 0) continue;
    const end = rawOffset(text, at + signature.length);
    return { count, lastColumn: Math.max(0, end - (text.lastIndexOf("\n") + 1)) };
  }
  return null;
}

/** The offset of the nth character after compressing blanks in the original text */
function rawOffset(text: string, normalizedEnd: number): number {
  let i = 0;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  let seen = 0;
  while (i < text.length && seen < normalizedEnd) {
    if (/\s/.test(text[i] as string)) {
      while (i < text.length && /\s/.test(text[i] as string)) i++;
    } else {
      i++;
    }
    seen++;
  }
  return i;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Range = [number, number];

/**
 * Which paragraphs were changed in the old and new versions of the signature: perform the longest common subsequence by words, and words that do not match are the changes.
 * By words rather than characters, so as not to split an identifier in half; merge changes separated only by whitespace into one section. Intervals are left-closed and right-open.
 */
export function changedRanges(before: string, after: string): { before: Range[]; after: Range[] } {
  const a = tokenize(before);
  const b = tokenize(after);
  const width = b.length + 1;
  // lcs[i][j]: the length of the longest common subsequence of a[i..] and b[j..]; the signature is at most a few hundred characters, so the table is not large
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i]?.text === b[j]?.text
        ? (lcs[(i + 1) * width + j + 1] as number) + 1
        : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
    }
  }
  const changedA: Token[] = [];
  const changedB: Token[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]?.text === b[j]?.text) {
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
      changedA.push(a[i++] as Token);
    } else {
      changedB.push(b[j++] as Token);
    }
  }
  changedA.push(...a.slice(i));
  changedB.push(...b.slice(j));
  return { before: toRanges(before, changedA), after: toRanges(after, changedB) };
}

interface Token {
  text: string;
  start: number;
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}_$]+|\s+|[^\s\p{L}\p{N}_$]/gu)].map((match) => ({ text: match[0], start: match.index }));
}

function toRanges(text: string, changed: readonly Token[]): Range[] {
  const ranges: Range[] = [];
  for (const token of changed) {
    if (token.text.trim() === "") continue;
    const end = token.start + token.text.length;
    const last = ranges.at(-1);
    if (last && text.slice(last[1], token.start).trim() === "") last[1] = end;
    else ranges.push([token.start, end]);
  }
  return ranges;
}

/** Take the portion of the [from, to) columns in a line of highlighted tokens */
export function sliceTokens(tokens: readonly CodeToken[], from: number, to = Infinity): CodeToken[] {
  const out: CodeToken[] = [];
  let offset = 0;
  for (const token of tokens) {
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + token[0].length);
    if (end > start) out.push([token[0].slice(start - offset, end - offset), token[1], token[2]]);
    offset += token[0].length;
  }
  return out;
}

/** The common leading whitespace width of each line; blank lines are not included */
export function commonIndent(lines: readonly string[]): number {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  return indent === Infinity ? 0 : indent;
}
