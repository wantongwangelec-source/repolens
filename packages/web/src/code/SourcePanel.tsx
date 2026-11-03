import type { NoteDto, PseudocodeStepDto } from "@repolens/core/types";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { readPref, writePref } from "../lib/prefs";
import { NoteCard } from "../notes/NoteCard";
import { formatLines } from "../store/useNotesStore";
import { Chevron } from "../ui/Chevron";
import { CodeLine } from "../ui/CodeLines";
import { hasLines } from "./PseudocodePanel";
import { useSource } from "./useSource";

const DocMarkdown = lazy(() => import("../ui/ChatMarkdown").then((module) => ({ default: module.DocMarkdown })));

const ANNOTATION_STORAGE_KEY = "repolens:source-annotations";
const PREVIEW_STORAGE_KEY = "repolens:markdown-preview";
const STEP_COLOR = "color-mix(in srgb, var(--color-accent) 55%, transparent)";
const TOP_STEP_BACKGROUND = "color-mix(in srgb, var(--color-accent) 10%, transparent)";
const CHILD_STEP_BACKGROUND = "color-mix(in srgb, var(--color-accent) 5%, transparent)";
const NOTE_BACKGROUND = "color-mix(in srgb, var(--color-note) 9%, transparent)";

export interface SourceFocus {
  lines: [number, number];
  /** Even if jumping twice consecutively within the same range, scrolling needs to be reset */
  nonce: number;
}

interface Anchor {
  step: PseudocodeStepDto;
  label: string;
  /** Sequence number of the top-level step; sub-steps are null */
  index: number | null;
}

/**
 * Source code tab.
 *
 * When there is pseudocode, by default insert the steps as comments above the lines of code they describe, with a colored bar on the left.
 * The scope covered by each step — this is 'having an outline on hand when reading source code,' compared with the pseudocode tab
 * "Looking at the outline first and drilling down into the source code as needed" are two directions that complement each other. Each step can be folded, and when all are folded
 * It just degenerates into pseudocode with line numbers.
 */
export function SourcePanel({
  fileId,
  from,
  to,
  steps,
  focus,
  notes,
}: {
  fileId: string;
  from?: number;
  to?: number;
  steps?: PseudocodeStepDto[] | null;
  focus?: SourceFocus | null;
  /** The notes on this document; inserted with line numbers below the last line of the recorded range */
  notes?: NoteDto[];
}) {
  const t = useT();
  const { source, error } = useSource(fileId, from, to);
  const annotatable = hasLines(steps);
  const [annotate, setAnnotate] = useState(readAnnotationPreference);
  // Jumping in with the line numbers means you want to look at those few lines, give the source code first.
  const [preview, setPreview] = useState(() => !focus && readPreviewPreference());
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const [marked, setMarked] = useState<[number, number] | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const lineRefs = useRef(new Map<number, HTMLDivElement>());
  const viewportWidth = useElementWidth(scroller);

  const showAnnotations = annotatable && annotate;
  const topSteps = useMemo(() => steps ?? [], [steps]);

  const anchors = useMemo(() => {
    const map = new Map<number, Anchor[]>();
    if (!showAnnotations) return map;
    const add = (line: number, anchor: Anchor) => map.set(line, [...(map.get(line) ?? []), anchor]);
    topSteps.forEach((step, index) => {
      if (step.lines) add(step.lines[0], { step, label: String(index + 1), index });
      for (const child of step.children) {
        // Sub-steps that start on the same line as the parent step are included in the parent annotation and no longer occupy a separate line.
        if (child.lines && child.lines[0] !== step.lines?.[0]) add(child.lines[0], { step: child, label: "•", index: null });
      }
    });
    return map;
  }, [showAnnotations, topSteps]);

  /** The top-level step to which each line belongs; when overlapping, the later step overrides the earlier one, consistent with the reading order of the annotations */
  const owners = useMemo(() => {
    if (!source || !showAnnotations) return null;
    const owner = new Int32Array(source.lines.length).fill(-1);
    topSteps.forEach((step, index) => {
      if (!step.lines) return;
      for (let line = step.lines[0]; line <= step.lines[1]; line++) {
        const offset = line - source.slice.startLine;
        if (offset >= 0 && offset < owner.length) owner[offset] = index;
      }
    });
    return owner;
  }, [source, showAnnotations, topSteps]);

  /** Group according to the last line of the note range; ranges that exceed the current segment fall to the edge of the segment */
  const noteRows = useMemo(() => {
    const map = new Map<number, NoteDto[]>();
    if (!source) return { at: map, covered: () => false };
    const { startLine, endLine } = source.slice;
    const ranged = (notes ?? []).flatMap((note) =>
      note.target.kind === "file" && note.target.lines ? [{ note, lines: note.target.lines }] : [],
    );
    for (const { note, lines } of ranged) {
      if (lines[1] < startLine || lines[0] > endLine) continue;
      const line = Math.min(lines[1], endLine);
      map.set(line, [...(map.get(line) ?? []), note]);
    }
    const covered = (line: number) => ranged.some(({ lines }) => line >= lines[0] && line <= lines[1]);
    return { at: map, covered };
  }, [source, notes]);

  const loaded = source !== null;
  const markdown = source !== null && isMarkdown(source.slice.language, source.slice.path);
  const previewing = markdown && preview;

  useEffect(() => {
    if (focus) setPreview(false);
  }, [focus]);

  useEffect(() => {
    if (!focus || !loaded || previewing) return;
    setMarked(focus.lines);
    setFolded((current) => {
      const next = new Set(current);
      topSteps.forEach((step, index) => {
        if (step.lines && step.lines[0] <= focus.lines[1] && step.lines[1] >= focus.lines[0]) next.delete(index);
      });
      return next.size === current.size ? current : next;
    });
    const frame = requestAnimationFrame(() => {
      lineRefs.current.get(focus.lines[0])?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, loaded, topSteps, previewing]);

  if (error) return <div className="p-3 text-[11.5px] text-[var(--color-ink-faint)]">{error}</div>;
  if (!source) return <SourceSkeleton />;

  const toggleFold = (index: number) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const rows: ReactNode[] = [];
  const pushNotes = (line: number) => {
    for (const note of noteRows.at.get(line) ?? []) {
      rows.push(<SourceNote key={`n:${note.id}`} note={note} width={viewportWidth} gutter={showAnnotations} />);
    }
  };
  const foldedStepAt = (line: number) =>
    topSteps.findIndex((step, index) => folded.has(index) && step.lines && line >= step.lines[0] && line <= step.lines[1]);

  for (let offset = 0; offset < source.lines.length; offset++) {
    const line = source.slice.startLine + offset;
    const foldedIndex = showAnnotations ? foldedStepAt(line) : -1;

    for (const anchor of anchors.get(line) ?? []) {
      // Within the folded range, only keep the annotations of the fold step itself
      if (foldedIndex >= 0 && anchor.index !== foldedIndex) continue;
      rows.push(
        <Annotation
          key={`a:${line}:${anchor.label}:${anchor.step.text}`}
          anchor={anchor}
          width={viewportWidth}
          folded={anchor.index !== null && folded.has(anchor.index)}
          onToggle={anchor.index !== null ? () => toggleFold(anchor.index!) : undefined}
        />,
      );
    }

    if (foldedIndex >= 0) {
      const range = topSteps[foldedIndex]!.lines!;
      if (line === Math.max(range[0], source.slice.startLine)) {
        rows.push(
          <button
            key={`f:${line}`}
            type="button"
            onClick={() => toggleFold(foldedIndex)}
            className="sticky left-0 block py-0.5 pl-[calc(2.5rem+3px)] text-left text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-accent)]"
            style={{ width: viewportWidth || undefined }}
          >
            ⋯ {t("已折叠 L{from}–{to}，共 {count} 行", { from: range[0], to: range[1], count: range[1] - range[0] + 1 })}
          </button>,
        );
      }
      // The notes recorded in the folded code still show up, and the notes are more worth seeing than those few lines of code.
      pushNotes(line);
      continue;
    }

    const owner = owners?.[offset] ?? -1;
    rows.push(
      <CodeLine
        key={line}
        number={line}
        text={source.lines[offset] ?? ""}
        tokens={source.tokens?.[offset]}
        marked={marked !== null && line >= marked[0] && line <= marked[1]}
        noted={noteRows.covered(line)}
        gutter={showAnnotations ? (owner >= 0 ? STEP_COLOR : null) : undefined}
        lineRef={(el) => {
          if (el) lineRefs.current.set(line, el);
          else lineRefs.current.delete(line);
        }}
      />,
    );
    pushNotes(line);
  }

  const allFolded = topSteps.every((step, index) => !step.lines || folded.has(index));

  return (
    <div className="flex min-h-full flex-col" data-source-file={fileId}>
      <div className="sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)]/95 px-3 text-[10.5px] text-[var(--color-ink-faint)] backdrop-blur">
        <span className="mono truncate tabular-nums">
          L{source.slice.startLine}–{source.slice.endLine} · {t("{count} 行", { count: source.lines.length })}
        </span>
        {(markdown || annotatable) && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {markdown && (
              <div className="flex overflow-hidden rounded border border-[var(--color-line)]">
                {([[true, t("预览")], [false, t("源码")]] as const).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={preview === value}
                    onClick={() => {
                      setPreview(value);
                      writePref(PREVIEW_STORAGE_KEY, value ? "on" : "off");
                    }}
                    className={`px-1.5 py-0.5 transition-colors ${
                      preview === value
                        ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                        : "hover:text-[var(--color-ink-muted)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {/* 伪代码注解只对源码有意义，预览时一起收起 */}
            {!previewing && showAnnotations && (
              <button
                type="button"
                onClick={() =>
                  setFolded(allFolded ? new Set() : new Set(topSteps.flatMap((step, i) => (step.lines ? [i] : []))))
                }
                className="rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink-muted)]"
              >
                {allFolded ? t("全部展开") : t("全部折叠")}
              </button>
            )}
            {!previewing && annotatable && (
              <button
                type="button"
                aria-pressed={annotate}
                onClick={() => {
                  const next = !annotate;
                  setAnnotate(next);
                  writeAnnotationPreference(next);
                }}
                title={t("在源码中穿插 AI 伪代码步骤")}
                className={`rounded border px-1.5 py-0.5 transition-colors ${
                  annotate
                    ? "border-[var(--color-accent)]/50 text-[var(--color-accent)]"
                    : "border-[var(--color-line)] hover:text-[var(--color-ink-muted)]"
                }`}
              >
                {t("伪代码注解")}
              </button>
            )}
          </div>
        )}
      </div>
      {previewing ? (
        <div className="px-4 py-3">
          <Suspense fallback={<SourceSkeleton />}>
            <DocMarkdown content={source.slice.code} />
          </Suspense>
        </div>
      ) : (
        <div ref={setScroller} className="thin-scroll flex-1 overflow-x-auto">
          <div className="w-max min-w-full py-2">{rows}</div>
        </div>
      )}
    </div>
  );
}

function isMarkdown(language: string, path: string): boolean {
  return language === "markdown" || /\.(?:md|mdx|markdown)$/i.test(path);
}

/**
 * Use the same set of columns as CodeLine: color bar, line number column, main text. The serial number and dot fall in the line number column along with the line number.
 * Right-aligned, the text starts from the first column of the code, and when reading, the comment and the code below it form a vertical line.
 */
function Annotation({
  anchor,
  width,
  folded,
  onToggle,
}: {
  anchor: Anchor;
  width: number;
  folded: boolean;
  onToggle: (() => void) | undefined;
}) {
  const t = useT();
  const top = anchor.index !== null;
  const lines = anchor.step.lines;
  const merged = top ? anchor.step.children.filter((child) => child.lines?.[0] === lines?.[0]) : [];
  return (
    <div
      className={`sticky left-0 flex items-baseline pr-2 ${top ? "mt-2 first:mt-0 py-1" : "py-0.5"}`}
      style={{ width: width || undefined, background: top ? TOP_STEP_BACKGROUND : CHILD_STEP_BACKGROUND }}
    >
      <span className="w-[3px] shrink-0 self-stretch" style={{ background: top ? "var(--color-accent)" : STEP_COLOR }} />
      <span
        className={`mono w-10 shrink-0 select-none pr-2.5 text-right text-[11px] leading-[1.6] tabular-nums ${
          top ? "font-semibold text-[var(--color-accent)]" : "text-[var(--color-accent)]/70"
        }`}
      >
        {anchor.label}
      </span>
      <span
        className={`min-w-0 flex-1 pr-1 leading-[1.6] ${
          top ? "text-[11.5px] font-medium text-[var(--color-ink)]" : "text-[11px] text-[var(--color-ink-muted)]"
        }`}
      >
        {anchor.step.text}
        {merged.length > 0 && (
          <span className="ml-1 text-[11px] font-normal text-[var(--color-ink-muted)]">
            · {merged.map((child) => child.text).join(" · ")}
          </span>
        )}
      </span>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          title={folded ? t("展开这一步的源码") : t("折叠这一步的源码")}
          className="flex h-[1.6em] w-4 shrink-0 self-start items-center justify-center rounded text-[11.5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
        >
          <Chevron open={!folded} />
        </button>
      )}
    </div>
  );
}

/**
 * The notes in the source code use the same column as annotations: the line number column is marked with ✎, and the main text starts from the first column of the code.
 * By default, only two lines are shown. Click to see the full note card, and you can delete it directly here.
 */
function SourceNote({ note, width, gutter }: { note: NoteDto; width: number; gutter: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lines = note.target.kind === "file" ? note.target.lines : null;
  return (
    <div
      className="sticky left-0 my-1 flex items-baseline pr-2"
      // When there is no column for step color bars, use inner shadow to draw vertical bars, which do not take up width, so that the line number column can align with the code.
      style={{
        width: width || undefined,
        background: NOTE_BACKGROUND,
        boxShadow: gutter ? undefined : "inset 3px 0 0 var(--color-note)",
      }}
    >
      {gutter && <span className="w-[3px] shrink-0 self-stretch bg-[var(--color-note)]" />}
      <span className="mono w-10 shrink-0 select-none pr-2.5 text-right text-[11px] leading-[1.6] text-[var(--color-note)]">
        ✎
      </span>
      {open ? (
        <div className="min-w-0 flex-1 py-1.5 pr-1">
          <NoteCard note={note} showPath={false} onLocate={null} />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-1 text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
          >
            {t("收起笔记")}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={t("展开笔记")}
            className="min-w-0 flex-1 py-1 text-left text-[11px] leading-[1.6] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
          >
            <span className="line-clamp-2">{notePreview(note.text)}</span>
          </button>
          {lines && (
            <span className="mono shrink-0 pl-2 text-[10px] leading-[1.6] text-[var(--color-ink-faint)]">
              {formatLines(lines)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** Only remove the Markdown markup itself; single underscores and asterisks are mostly part of identifiers or expressions. */
function notePreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " … ")
    .replace(/`+/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s*(?:#+|>|[-*]\s)\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function SourceSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-[var(--color-surface-3)]"
          style={{ width: `${88 - i * 11}%` }}
        />
      ))}
    </div>
  );
}

/** Annotations should remain visible when scrolling horizontally and wrap according to the visible width, so the width is set to the visible width of the scroll container. */
function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

function readAnnotationPreference(): boolean {
  return readPref(ANNOTATION_STORAGE_KEY) !== "off";
}

function writeAnnotationPreference(value: boolean): void {
  writePref(ANNOTATION_STORAGE_KEY, value ? "on" : "off");
}

/** Markdown displays the rendered result by default, which is consistent with opening the document on a code hosting platform. */
function readPreviewPreference(): boolean {
  return readPref(PREVIEW_STORAGE_KEY) !== "off";
}
