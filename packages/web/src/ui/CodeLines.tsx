import type { CSSProperties, ReactNode, Ref } from "react";
import type { CodeToken } from "../lib/highlight";

const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

/** A segment of markup within a line, columns are UTF-16 offsets, left-closed right-open */
export interface CodeMark {
  from: number;
  to: number;
  className: string;
  title?: string;
  onClick?: () => void;
}

/** Cut the highlighted tokens along the marked boundaries; fragments under the same token are collected into an outer span so that the background and underline remain continuous. */
function markedRuns(text: string, tokens: CodeToken[] | null | undefined, marks: readonly CodeMark[]) {
  const base: CodeToken[] = tokens && tokens.length > 0 ? tokens : [[text, null, 0]];
  const runs: Array<{ mark: CodeMark | null; pieces: CodeToken[] }> = [];
  let offset = 0;
  for (const token of base) {
    const value = token[0];
    let start = 0;
    while (start < value.length) {
      const at = offset + start;
      const mark = marks.find((item) => at >= item.from && at < item.to) ?? null;
      let end = value.length;
      for (const item of marks) {
        if (item.from > at) end = Math.min(end, item.from - offset);
        if (item.to > at) end = Math.min(end, item.to - offset);
      }
      const piece: CodeToken = [value.slice(start, end), token[1], token[2]];
      const last = runs.at(-1);
      if (last && last.mark === mark) last.pieces.push(piece);
      else runs.push({ mark, pieces: [piece] });
      start = end;
    }
    offset += value.length;
  }
  return runs;
}

function tokenStyle([, color, fontStyle]: CodeToken): CSSProperties | undefined {
  if (color === null && fontStyle === 0) return undefined;
  return {
    ...(color === null ? {} : { color }),
    ...(fontStyle & ITALIC ? { fontStyle: "italic" } : {}),
    ...(fontStyle & BOLD ? { fontWeight: 600 } : {}),
    ...(fontStyle & UNDERLINE ? { textDecoration: "underline" } : {}),
  };
}

export function CodeLine({
  number,
  text,
  tokens,
  marked = false,
  noted = false,
  gutter,
  lineRef,
  marks,
  wrap = false,
}: {
  number: number | null;
  text: string;
  tokens: CodeToken[] | null | undefined;
  marked?: boolean;
  /** Mark this line as noted, change the line number to note color */
  noted?: boolean;
  /** The thin colored bar on the left side of the line number is used to associate a section of source code with a certain pseudocode step; when undefined, it does not take up space. */
  gutter?: string | null;
  lineRef?: Ref<HTMLDivElement>;
  marks?: readonly CodeMark[];
  /** When extremely wide, it wraps within the container, with hanging indentation for continued lines, distinguishable from a real line break */
  wrap?: boolean;
}) {
  let content: ReactNode;
  if (marks && marks.length > 0) {
    content = markedRuns(text, tokens, marks).map((run, index) => {
      const pieces = run.pieces.map((token, i) => <span key={i} style={tokenStyle(token)}>{token[0]}</span>);
      if (!run.mark) return <span key={index}>{pieces}</span>;
      const { className, title, onClick } = run.mark;
      return (
        <span key={index} className={className} title={title} onClick={onClick}>
          {pieces}
        </span>
      );
    });
  } else if (tokens && tokens.length > 0) {
    content = tokens.map((token, index) => (
      <span key={index} style={tokenStyle(token)}>
        {token[0]}
      </span>
    ));
  } else {
    content = text || " ";
  }
  return (
    <div
      ref={lineRef}
      data-line={number ?? undefined}
      className={`mono flex text-[11px] leading-[1.6] transition-colors ${
        marked ? "bg-[var(--color-accent)]/12" : ""
      }`}
    >
      {gutter !== undefined && (
        <span className="w-[3px] shrink-0" style={{ background: gutter ?? "transparent" }} />
      )}
      {number !== null && (
        <span
          className={`w-10 shrink-0 select-none pr-2.5 text-right tabular-nums ${
            noted ? "text-[var(--color-note)]" : "text-[var(--color-ink-faint)]"
          }`}
        >
          {number}
        </span>
      )}
      {wrap ? (
        <span
          className="min-w-0 whitespace-pre-wrap text-[var(--code-foreground)] [overflow-wrap:anywhere]"
          style={{ paddingLeft: "2ch", textIndent: "-2ch" }}
        >
          {content}
        </span>
      ) : (
        <span className="whitespace-pre pr-3 text-[var(--code-foreground)]">{content}</span>
      )}
    </div>
  );
}

/** A continuous segment of source code. The width stretches to the longest line, and horizontal scrolling is handled by the outer container. */
export function CodeBlock({
  lines,
  tokens,
  firstLine,
  className = "",
}: {
  lines: string[];
  tokens: CodeToken[][] | null;
  firstLine: number;
  className?: string;
}) {
  return (
    <div className={`thin-scroll overflow-x-auto ${className}`}>
      <div className="w-max min-w-full py-1.5">
        {lines.map((line, index) => {
          const number = firstLine + index;
          return (
            <CodeLine key={number} number={number} text={line} tokens={tokens?.[index]} />
          );
        })}
      </div>
    </div>
  );
}
