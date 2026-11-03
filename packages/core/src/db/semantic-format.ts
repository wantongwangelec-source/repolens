/** Deterministic formatting shared by AI text when writing to the cache and reading old cache. */

import type { PseudocodeStepDto } from "../types.js";

export type SemanticTextFlavor =
  | "summary"
  | "summary-v2"
  | "tooltip-summary"
  | "pseudocode"
  | "pseudocode-map";

interface StructuredSummary {
  purpose?: unknown;
  keyConcepts?: unknown;
  workflow?: unknown;
  notes?: unknown;
}

interface StructuredPseudocodeStep {
  step?: unknown;
  details?: unknown;
}

export function normalizeSemanticContent(
  value: string,
  flavor: SemanticTextFlavor,
  lang: "zh" | "en" = "zh",
): string {
  switch (flavor) {
    case "summary":
      return cleanText(value, 12_000) ?? "";
    case "summary-v2":
      return normalizeSummary(value, 12_000, lang) ?? "";
    case "tooltip-summary":
      return cleanSingleLine(value, 240) ?? "";
    case "pseudocode":
      return normalizePseudocode(value, 16_000) ?? "";
    // The pseudocode-map is a JSON string and cannot have backslashes rewritten before parsing.
    case "pseudocode-map":
      return value;
  }
}

export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = normalizeRawText(value).replace(/[ \t]+$/gm, "").trim();
  return text === "" ? null : text.slice(0, maxLength);
}

export function cleanSingleLine(value: unknown, maxLength: number): string | null {
  const text = cleanText(value, Math.max(maxLength * 4, maxLength));
  if (text === null) return null;
  const compact = text
    .replace(/\s+/g, " ")
    .replace(/^(用途|Purpose)\s*[:：]\s*/i, "")
    .trim();
  const cjkSentence = /^(.+?[。！？])/.exec(compact)?.[1];
  const latinSentence = /^(.+?[.!?])(?:\s|$)/.exec(compact)?.[1];
  const sentence = cjkSentence ?? latinSentence ?? compact;
  return sentence === "" ? null : sentence.slice(0, maxLength);
}

/** Fix the abstract into a named short paragraph, and repair the literal line breaks left by the compatible interface. */
export function normalizeSummary(
  value: unknown,
  maxLength: number,
  lang: "zh" | "en" = "zh",
): string | null {
  if (isRecord(value)) return normalizeStructuredSummary(value, maxLength, lang);
  const raw = cleanText(value, maxLength * 2);
  if (raw === null) return null;
  let text = stripCodeFence(raw);
  const headings: Array<[RegExp, string]> = lang === "zh"
    ? [
        [/(?:#{1,6}\s*)?(?:\*\*)?用途\s*[:：](?:\*\*)?/gi, "用途："],
        [/(?:#{1,6}\s*)?(?:\*\*)?核心概念\s*[:：](?:\*\*)?/gi, "核心概念："],
        [/(?:#{1,6}\s*)?(?:\*\*)?工作方式\s*[:：](?:\*\*)?/gi, "工作方式："],
        [/(?:#{1,6}\s*)?(?:\*\*)?使用提示\s*[:：](?:\*\*)?/gi, "使用提示："],
      ]
    : [
        [/(?:#{1,6}\s*)?(?:\*\*)?Purpose\s*:(?:\*\*)?/gi, "Purpose:"],
        [/(?:#{1,6}\s*)?(?:\*\*)?Key concepts\s*:(?:\*\*)?/gi, "Key concepts:"],
        [/(?:#{1,6}\s*)?(?:\*\*)?How it works\s*:(?:\*\*)?/gi, "How it works:"],
        [/(?:#{1,6}\s*)?(?:\*\*)?Usage notes\s*:(?:\*\*)?/gi, "Usage notes:"],
      ];
  for (const [pattern, heading] of headings) text = text.replace(pattern, "\n\n" + heading);
  let paragraphs = text
    .replace(/^\s+/, "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const purposeHeading = lang === "zh" ? "用途：" : "Purpose: ";
  const knownHeadings = lang === "zh"
    ? /^(用途|核心概念|工作方式|使用提示)[：:]/
    : /^(Purpose|Key concepts|How it works|Usage notes):/i;
  if (paragraphs[0] && !knownHeadings.test(paragraphs[0])) {
    paragraphs[0] = purposeHeading + paragraphs[0];
  }
  paragraphs = paragraphs.map((paragraph) => formatSummaryParagraph(paragraph, lang));
  const normalized = mergeSummaryParagraphs(paragraphs, lang);
  return normalized === "" ? null : normalized.slice(0, maxLength);
}

/** Top-level steps are numbered consecutively, and sub-steps always use two spaces and a dash. */
export function normalizePseudocode(
  value: unknown,
  maxLength: number,
  maxLines = 32,
): string | null {
  const rawLines = Array.isArray(value)
    ? structuredPseudocodeLines(value)
    : pseudocodeStringLines(value, maxLength);
  if (rawLines === null || rawLines.length === 0) return null;

  const limited = rawLines.slice(0, maxLines);
  const indents = limited.map((line) => line.match(/^ */)?.[0].length ?? 0);
  const commonIndent = Math.min(...indents);
  let ordinal = 0;
  const lines = limited.map((line, index) => {
    const indent = Math.max(0, (indents[index] ?? 0) - commonIndent);
    const content = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, "")
      .trim();
    if (indent === 0) {
      ordinal++;
      return String(ordinal) + ". " + content;
    }
    const depth = Math.min(4, Math.max(1, Math.ceil(indent / 2)));
    return "  ".repeat(depth) + "- " + content;
  });
  const normalized = lines.join("\n");
  return normalized === "" ? null : normalized.slice(0, maxLength);
}

export interface SourceLineBounds {
  from: number;
  to: number;
}

/**
 * Organize the pseudocode returned by the model into a 'step → source code line' structure.
 *
 * The line number is only used for deterministic verification: swaps with reversed order, partially out-of-bounds included within the range, completely out of range
 * Discard; when the parent step lacks a line number, use the union of the sub-steps to fill it in. When the model only provides a string, it degrades to
 * Steps without line numbers will display text on the interface as usual, but you won't be able to preview or locate the corresponding source code.
 */
export function normalizePseudocodeSteps(
  value: unknown,
  bounds: SourceLineBounds,
  maxLines = 32,
): PseudocodeStepDto[] | null {
  if (!Array.isArray(value)) {
    const text = normalizePseudocode(value, 16_000, maxLines);
    return text === null ? null : parsePseudocodeText(text);
  }

  const steps: PseudocodeStepDto[] = [];
  let budget = maxLines;
  for (const raw of value) {
    if (budget <= 0) break;
    const record: Record<string, unknown> = isRecord(raw) ? raw : { step: raw };
    const text = cleanStepText(record["step"] ?? record["text"]);
    if (text === null) continue;
    budget--;

    const children: PseudocodeStepDto[] = [];
    const details = Array.isArray(record["details"]) ? record["details"].slice(0, 8) : [];
    for (const detail of details) {
      if (budget <= 0) break;
      const child: Record<string, unknown> = isRecord(detail) ? detail : { text: detail };
      const childText = cleanStepText(child["text"] ?? child["step"]);
      if (childText === null) continue;
      budget--;
      children.push({ text: childText, lines: parseLineRange(child["lines"], bounds), children: [] });
    }

    steps.push({
      text,
      lines: parseLineRange(record["lines"], bounds) ?? unionRange(children),
      children,
    });
  }
  return steps.length === 0 ? null : steps;
}

/** Consistent with the output format of normalizePseudocode, continue to use it in places of read-only text such as hover cards. */
export function pseudocodeStepsToText(steps: readonly PseudocodeStepDto[]): string {
  return steps
    .flatMap((step, index) => [
      String(index + 1) + ". " + step.text,
      ...step.children.map((child) => "  - " + child.text),
    ])
    .join("\n");
}

/** The old cache only contains the normalized text: the top level is 'N. ', and the sub-steps are indented '-'. */
export function parsePseudocodeText(text: string): PseudocodeStepDto[] | null {
  const steps: PseudocodeStepDto[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const content = cleanStepText(line);
    if (content === null) continue;
    const parent = steps.at(-1);
    if (/^\s/.test(line) && parent) parent.children.push({ text: content, lines: null, children: [] });
    else steps.push({ text: content, lines: null, children: [] });
  }
  return steps.length === 0 ? null : steps;
}

/** Read the pseudocode-map cache; if the shape is incorrect, treat it as nonexistent, rather than handing a half-finished structure to the interface. */
export function parsePseudocodeSteps(raw: string): PseudocodeStepDto[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const read = (item: unknown, depth: number): PseudocodeStepDto | null => {
    if (!isRecord(item) || typeof item["text"] !== "string") return null;
    const lines = item["lines"];
    const validLines = Array.isArray(lines) && lines.length === 2 &&
      lines.every((n) => Number.isInteger(n)) && (lines[0] as number) <= (lines[1] as number)
      ? [lines[0], lines[1]] as [number, number]
      : null;
    const children = depth === 0 && Array.isArray(item["children"])
      ? item["children"].map((child) => read(child, 1)).filter((c): c is PseudocodeStepDto => c !== null)
      : [];
    return { text: item["text"], lines: validLines, children };
  };
  const steps = value.map((item) => read(item, 0)).filter((s): s is PseudocodeStepDto => s !== null);
  return steps.length === 0 ? null : steps;
}

function cleanStepText(value: unknown): string | null {
  const text = cleanText(value, 1_000);
  if (text === null) return null;
  const content = collapseLines(text)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, "")
    .trim();
  return content === "" ? null : content;
}

function parseLineRange(value: unknown, bounds: SourceLineBounds): [number, number] | null {
  let start: number | null = null;
  let end: number | null = null;
  if (Array.isArray(value)) {
    start = lineNumber(value[0]);
    end = lineNumber(value[1] ?? value[0]);
  } else if (typeof value === "number") {
    start = end = lineNumber(value);
  } else if (typeof value === "string") {
    const match = /L?(\d+)(?:\s*[-–~,]\s*L?(\d+))?/i.exec(value);
    if (match) {
      start = lineNumber(match[1]);
      end = lineNumber(match[2] ?? match[1]);
    }
  } else if (isRecord(value)) {
    start = lineNumber(value["start"] ?? value["from"]);
    end = lineNumber(value["end"] ?? value["to"] ?? value["start"] ?? value["from"]);
  }
  if (start === null || end === null) return null;
  if (start > end) [start, end] = [end, start];
  if (end < bounds.from || start > bounds.to) return null;
  return [Math.max(start, bounds.from), Math.min(end, bounds.to)];
}

function lineNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function unionRange(steps: readonly PseudocodeStepDto[]): [number, number] | null {
  const ranges = steps.map((step) => step.lines).filter((r): r is [number, number] => Boolean(r));
  if (ranges.length === 0) return null;
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
}

function normalizeStructuredSummary(
  value: StructuredSummary,
  maxLength: number,
  lang: "zh" | "en",
): string | null {
  const labels = summaryLabels(lang);
  const purposeParts = splitPurpose(cleanText(value.purpose, 2_000), lang);
  const concepts = stringList(value.keyConcepts, 8);
  const workflow = [
    ...(purposeParts.implementation ? [purposeParts.implementation] : []),
    ...stringList(value.workflow, 10),
  ];
  const notes = stringList(value.notes, 6);
  const paragraphs = [
    purposeParts.purpose ? labels.purpose + purposeParts.purpose : null,
    concepts.length > 0
      ? labels.concepts + "\n" + concepts.map((item) => "- " + item).join("\n")
      : null,
    workflow.length > 0
      ? labels.workflow + "\n" + workflow.map((item, index) => String(index + 1) + ". " + item).join("\n")
      : null,
    notes.length > 0
      ? labels.notes + "\n" + notes.map((item) => "- " + item).join("\n")
      : null,
  ].filter((item): item is string => item !== null);
  const normalized = paragraphs.join("\n\n");
  return normalized === "" ? null : normalized.slice(0, maxLength);
}

function formatSummaryParagraph(paragraph: string, lang: "zh" | "en"): string {
  const labels = summaryLabels(lang);
  const patterns: Array<[RegExp, string, "plain" | "bullets" | "steps"]> = lang === "zh"
    ? [
        [/^用途[：:]\s*/i, labels.purpose, "plain"],
        [/^核心概念[：:]\s*/i, labels.concepts, "bullets"],
        [/^工作方式[：:]\s*/i, labels.workflow, "steps"],
        [/^使用提示[：:]\s*/i, labels.notes, "bullets"],
      ]
    : [
        [/^Purpose:\s*/i, labels.purpose, "plain"],
        [/^Key concepts:\s*/i, labels.concepts, "bullets"],
        [/^How it works:\s*/i, labels.workflow, "steps"],
        [/^Usage notes:\s*/i, labels.notes, "bullets"],
      ];
  for (const [pattern, label, style] of patterns) {
    if (!pattern.test(paragraph)) continue;
    const body = paragraph.replace(pattern, "").trim();
    if (style === "plain") {
      const parts = splitPurpose(collapseLines(body), lang);
      if (parts.implementation) {
        return label + parts.purpose + "\n\n" + labels.workflow + "\n1. " + parts.implementation;
      }
      return label + (parts.purpose ?? "");
    }
    const items = summaryItems(body, lang);
    if (items.length === 0) return label;
    const lines = style === "steps"
      ? items.map((item, index) => String(index + 1) + ". " + item)
      : items.map((item) => "- " + item);
    return label + "\n" + lines.join("\n");
  }
  return collapseLines(paragraph);
}

/** After merging similar paragraphs, output them in a fixed order to avoid the old cache producing two 'working modes'. */
function mergeSummaryParagraphs(paragraphs: readonly string[], lang: "zh" | "en"): string {
  const labels = summaryLabels(lang);
  const purpose: string[] = [];
  const concepts: string[] = [];
  const workflow: string[] = [];
  const notes: string[] = [];
  const patterns: Array<[RegExp, string[]]> = lang === "zh"
    ? [
        [/^用途[：:]\s*/i, purpose],
        [/^核心概念[：:]\s*/i, concepts],
        [/^工作方式[：:]\s*/i, workflow],
        [/^使用提示[：:]\s*/i, notes],
      ]
    : [
        [/^Purpose:\s*/i, purpose],
        [/^Key concepts:\s*/i, concepts],
        [/^How it works:\s*/i, workflow],
        [/^Usage notes:\s*/i, notes],
      ];

  for (const block of paragraphs.flatMap((paragraph) => paragraph.split(/\n{2,}/))) {
    const trimmed = block.trim();
    let matched = false;
    for (const [pattern, target] of patterns) {
      if (!pattern.test(trimmed)) continue;
      const body = trimmed.replace(pattern, "").trim();
      if (target === purpose) {
        const text = collapseLines(body);
        if (text) target.push(text);
      } else {
        target.push(...summaryItems(body, lang));
      }
      matched = true;
      break;
    }
    if (!matched) {
      const text = collapseLines(trimmed);
      if (text) purpose.push(text);
    }
  }

  const sections = [
    purpose.length > 0 ? labels.purpose + unique(purpose).join(" ") : null,
    concepts.length > 0
      ? labels.concepts + "\n" + unique(concepts).slice(0, 8).map((item) => "- " + item).join("\n")
      : null,
    workflow.length > 0
      ? labels.workflow + "\n" + unique(workflow).slice(0, 12)
          .map((item, index) => String(index + 1) + ". " + item).join("\n")
      : null,
    notes.length > 0
      ? labels.notes + "\n" + unique(notes).slice(0, 8).map((item) => "- " + item).join("\n")
      : null,
  ].filter((item): item is string => item !== null);
  return sections.join("\n\n");
}

function summaryItems(value: string, lang: "zh" | "en"): string[] {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const explicitlyListed = lines.length > 1 || lines.some((line) => /^(?:[-*•]|\d+[.)、])\s*/.test(line));
  const source = explicitlyListed ? lines : value.split(lang === "zh" ? /；/ : /;\s+/);
  return source
    .map((item) => item.trim().replace(/^(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean);
}

function collapseLines(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function summaryLabels(lang: "zh" | "en") {
  return lang === "zh"
    ? { purpose: "用途：", concepts: "核心概念：", workflow: "工作方式：", notes: "使用提示：" }
    : { purpose: "Purpose: ", concepts: "Key concepts:", workflow: "How it works:", notes: "Usage notes:" };
}

function splitPurpose(value: string | null, lang: "zh" | "en"): {
  purpose: string | null;
  implementation: string | null;
} {
  if (!value) return { purpose: null, implementation: null };
  const prefix = lang === "zh" ? /^为什么需要\s*[：:]\s*/ : /^Why(?: it is)? needed\s*:\s*/i;
  const text = value.replace(prefix, "");
  const marker = lang === "zh" ? /[。.!?]\s*如何实现\s*[：:]\s*/ : /[.!?]\s*How it works\s*:\s*/i;
  const match = marker.exec(text);
  if (!match || match.index === undefined) return { purpose: text.trim(), implementation: null };
  const purpose = text.slice(0, match.index + 1).trim();
  const implementation = text.slice(match.index + match[0].length).trim();
  return { purpose, implementation: implementation || null };
}

function structuredPseudocodeLines(value: unknown[]): string[] {
  const lines: string[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      const step = cleanText(raw, 1_000);
      if (step) lines.push(step);
      continue;
    }
    if (!isRecord(raw)) continue;
    const step = cleanText((raw as StructuredPseudocodeStep).step, 1_000);
    if (!step) continue;
    lines.push(step);
    const details = (raw as StructuredPseudocodeStep).details;
    const detailTexts = Array.isArray(details)
      ? details.map((detail) => (isRecord(detail) ? detail["text"] : detail))
      : details;
    for (const detail of stringList(detailTexts, 8)) {
      lines.push("  " + detail);
    }
  }
  return lines;
}

function pseudocodeStringLines(value: unknown, maxLength: number): string[] | null {
  const raw = cleanText(value, maxLength * 2);
  if (raw === null) return null;
  return stripCodeFence(raw)
    .replace(/\t/g, "  ")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, 1_000))
    .filter((item): item is string => item !== null)
    .slice(0, limit);
}

function normalizeRawText(value: string): string {
  let text = decodeHtmlEntities(value).replace(/\r\n?/g, "\n");
  // Some compatible interfaces will escape JSON strings a second time, eventually leaving visible backslash+n.
  // Only restore when the entire paragraph has no real line breaks, or when there are multiple escaped line breaks, to avoid mistakenly affecting pseudo code.
  // Used to illustrate the single `
` in a string literal.
  const escapedBreaks = text.match(/\\r\\n|\\n|\\r/g)?.length ?? 0;
  if (escapedBreaks > 0 && (!text.includes("\n") || escapedBreaks > 1)) {
    text = text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n");
  }
  return text;
}

function stripCodeFence(value: string): string {
  const fence = String.fromCharCode(96).repeat(3);
  const lines = value.split("\n");
  if (lines[0]?.trim().startsWith(fence)) lines.shift();
  if (lines.at(-1)?.trim() === fence) lines.pop();
  return lines.join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only decode explicit character entities, do not parse AI text as HTML. */
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  };
  return value
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));/gi,
      (entity, hex: string | undefined, decimal: string | undefined) => {
        const codePoint = Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : entity;
      },
    )
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos);/gi,
      (entity, name: string) => named[name.toLowerCase()] ?? entity,
    );
}
