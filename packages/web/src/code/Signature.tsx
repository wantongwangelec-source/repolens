import { useMemo, useState } from "react";
import { useT } from "../i18n";
import { shikiLanguage, useHighlightedLines } from "../lib/highlight";
import { type CodeMark, CodeLine } from "../ui/CodeLines";
import { MAX_SIGNATURE, commonIndent, declarationHeader, sliceTokens } from "./declaration";
import { useSource } from "./useSource";

/** The declaration header spans so many lines that only the beginning is visible, and it shouldn't be entirely taken up by a single type definition in the overview. */
const MAX_HEADER_LINES = 12;

/** The signature stored in the index (compressed into one line) is highlighted by language, and if it's too long, it wraps within the container. */
export function SignatureText({
  code, path, language, marks,
}: {
  code: string;
  path: string;
  language?: string | null;
  marks?: readonly CodeMark[];
}) {
  const tokens = useHighlightedLines(code, shikiLanguage(language, path));
  return <CodeLine number={null} text={code} tokens={tokens?.[0]} marks={marks} wrap />;
}

/**
 * Declaration header of the symbol, taken from the original source code: retain the author's line breaks and indentation, with syntax highlighting, truncated before the function body.
 * When the source code cannot be read or does not match the index (the file has been modified after scanning), it falls back to a compressed single-line signature.
 */
export function DeclarationHeader({
  fileId, startLine, endLine, signature, path, language,
}: {
  fileId: string;
  startLine: number;
  endLine: number;
  signature: string;
  path: string;
  language: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  // Same set of parameters as the source code and pseudocode tabs, no need to request again when switching over
  const { source, error } = useSource(fileId, startLine, endLine);
  const header = useMemo(() => {
    if (!source) return null;
    const part = source.range(startLine, endLine);
    const found = declarationHeader(part.lines, signature);
    if (!found) return null;
    const lines = part.lines.slice(0, found.count);
    const tokens = part.tokens?.slice(0, found.count) ?? null;
    const last = lines.length - 1;
    lines[last] = (lines[last] as string).slice(0, found.lastColumn);
    if (tokens) tokens[last] = sliceTokens(tokens[last] ?? [], 0, found.lastColumn);
    const indent = commonIndent(lines);
    return {
      lines: lines.map((line) => line.slice(indent)),
      tokens: tokens?.map((line) => sliceTokens(line, indent)) ?? null,
    };
  }, [source, startLine, endLine, signature]);

  if (!source && !error) return null;
  if (!header) {
    return <Frame><SignatureText code={signature} path={path} language={language} /></Frame>;
  }
  const shown = expanded ? header.lines : header.lines.slice(0, MAX_HEADER_LINES);
  const hidden = header.lines.length - shown.length;
  return (
    <Frame>
      {shown.map((line, index) => (
        <CodeLine key={index} number={null} text={line} tokens={header.tokens?.[index]} wrap />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mono text-[11px] leading-[1.6] text-[var(--color-ink-faint)] hover:text-[var(--color-accent)]"
        >
          {t("… 还有 {count} 行", { count: hidden })}
        </button>
      ) : signature.length >= MAX_SIGNATURE ? (
        <div className="mono text-[11px] leading-[1.6] text-[var(--color-ink-faint)]">…</div>
      ) : null}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-1.5">
      {children}
    </div>
  );
}
