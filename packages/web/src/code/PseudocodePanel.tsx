import type { PseudocodeStepDto } from "@repolens/core/types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { CodeBlock } from "../ui/CodeLines";
import { useSource, type LoadedSource } from "./useSource";

/** The source code will only appear after hovering for this duration, and it won't flash when scanning through the list. */
const HOVER_DELAY_MS = 180;
/** The maximum number of rows for the initial render, high enough to fill high-resolution screens; the actual number displayed is measured based on the available height */
const PREVIEW_MAX_LINES = 120;
const PREVIEW_MIN_WIDTH = 280;
/** The preview does not cover the top bar, nor does it stick to the bottom edge of the window */
const PREVIEW_TOP = 56;
const PREVIEW_BOTTOM_MARGIN = 12;

export interface StepQuote {
  text: string;
  lines: [number, number] | null;
  /** Use the abbreviation on the reference tag, starting with the step number */
  label: string;
}

interface HoverState {
  range: [number, number];
  rect: DOMRect;
  drawerLeft: number;
}

/**
 * Pseudocode tab.
 *
 * Pseudocode is responsible for 'first understanding what it does': hovering for one step reveals the corresponding source code, clicking jumps to the source code tab
 * And positioning — if you need to see the context, go to the source code tab, don’t lay out another copy of the code in the narrow drawer. Line numbers correspond.
 * Relationships are labeled by AI and always displayed in the AI's highlight color on the interface.
 */
export function PseudocodePanel({
  steps,
  fileId,
  from,
  to,
  loading,
  error,
  loadingLabel,
  onGenerate,
  onJumpToSource,
  onAsk,
}: {
  steps: PseudocodeStepDto[] | null;
  fileId: string;
  from?: number;
  to?: number;
  loading: boolean;
  error: string | null;
  loadingLabel: string;
  onGenerate: (refresh?: boolean) => void;
  onJumpToSource: (lines: [number, number]) => void;
  onAsk: (quote: StepQuote) => void;
}) {
  const t = useT();
  const linked = useMemo(() => hasLines(steps), [steps]);
  const { source } = useSource(fileId, from, to);
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);

  if (!steps) {
    return (
      <div className="p-3">
        {loading ? (
          <InlineStatus label={loadingLabel} />
        ) : error ? (
          <div>
            <div className="text-[11px] text-[var(--color-warn)]">{error}</div>
            <ActionButton onClick={() => onGenerate()}>{t("重试")}</ActionButton>
          </div>
        ) : (
          <ActionButton onClick={() => onGenerate()}>{t("生成 AI 伪代码")}</ActionButton>
        )}
      </div>
    );
  }

  const markerWidth = stepMarkerWidth(steps.length);

  const scheduleHover = (target: HTMLElement, range: [number, number]) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    const rect = target.getBoundingClientRect();
    const drawerLeft = target.closest("aside")?.getBoundingClientRect().left ?? window.innerWidth;
    hoverTimer.current = window.setTimeout(() => setHover({ range, rect, drawerLeft }), HOVER_DELAY_MS);
  };
  const clearHover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  };
  const jump = (lines: [number, number]) => {
    clearHover();
    onJumpToSource(lines);
  };

  return (
    <div className="p-3" onMouseLeave={clearHover} data-source-file={fileId}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-accent)]">{t("AI 伪代码")}</span>
        {linked && (
          <span className="truncate text-[10px] text-[var(--color-ink-faint)]">{t("悬停预览源码 · 点击定位到源码")}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <RefreshButton loading={loading} onClick={() => onGenerate(true)} />
        </div>
      </div>

      {!linked && !loading && (
        <div className="mt-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-2 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
          {t("这份伪代码来自旧版缓存，还没有和源码行对应。")}
          <button
            type="button"
            onClick={() => onGenerate(true)}
            className="mx-0.5 text-[var(--color-accent)] hover:underline"
          >
            {t("重新生成")}
          </button>
          {t("后可以悬停预览、定位对应源码。")}
        </div>
      )}
      {loading && <InlineStatus label={t("正在重新生成伪代码与源码对应关系…")} />}
      {error && <div className="mt-2 text-[11px] text-[var(--color-warn)]">{t("刷新失败：{error}", { error })}</div>}

      <ol className="mt-2 space-y-1">
        {steps.map((step, index) => (
          <li key={index}>
            <StepRow
              marker={String(index + 1)}
              markerWidth={markerWidth}
              step={step}
              onHover={(el, lines) => scheduleHover(el, lines)}
              onLeave={clearHover}
              onJump={jump}
              onAsk={() => onAsk({
                text: t("步骤 {n}：{text}", { n: index + 1, text: step.text }),
                lines: step.lines ?? null,
                label: `#${index + 1} ${step.text}`,
              })}
            />
            {step.children.length > 0 && (
              <ul className="pb-0.5">
                {step.children.map((child, childIndex) => (
                  <li key={childIndex}>
                    <StepRow
                      marker={null}
                      markerWidth={markerWidth}
                      step={child}
                      onHover={(el, lines) => scheduleHover(el, lines)}
                      onLeave={clearHover}
                      onJump={jump}
                      onAsk={() =>
                        onAsk({
                          text: t("步骤 {n} 的子步骤：{text}", { n: index + 1, text: child.text }),
                          lines: child.lines ?? null,
                          label: `#${index + 1}.${childIndex + 1} ${child.text}`,
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      {linked && (
        <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
          {t("步骤与源码行的对应由 AI 标注，可能有几行偏差；以源码为准。")}
        </p>
      )}

      {hover && source && (
        <SourcePreview key={`${hover.range[0]}-${hover.range[1]}`} source={source} hover={hover} />
      )}
    </div>
  );
}

/**
 * A series of steps. Sub-steps (marker is null) first leave a space the same width as the number column, and the bullet points fall on
 * At the beginning of the parent step text, the hierarchy is read aligned with this vertical line, without additional indentation.
 */
function StepRow({
  marker,
  markerWidth,
  step,
  onHover,
  onLeave,
  onJump,
  onAsk,
}: {
  marker: string | null;
  markerWidth: string;
  step: PseudocodeStepDto;
  onHover: (el: HTMLElement, lines: [number, number]) => void;
  onLeave: () => void;
  onJump: (lines: [number, number]) => void;
  onAsk: () => void;
}) {
  const t = useT();
  const lines = step.lines ?? null;
  const child = marker === null;
  return (
    <div
      role={lines ? "button" : undefined}
      tabIndex={lines ? 0 : undefined}
      title={lines ? t("在源码标签中定位") : undefined}
      onClick={() => lines && onJump(lines)}
      onKeyDown={(event) => {
        if (lines && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onJump(lines);
        }
      }}
      onMouseEnter={(event) => lines && onHover(event.currentTarget, lines)}
      onMouseLeave={onLeave}
      className={`group -mx-1.5 flex items-start gap-1.5 rounded px-1.5 py-1 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
        lines ? "cursor-pointer hover:bg-[var(--color-surface-3)]/70" : ""
      }`}
    >
      <span
        className={`mono ${markerWidth} shrink-0 pt-px text-[10.5px] tabular-nums text-[var(--color-accent)]`}
        aria-hidden={child || undefined}
      >
        {marker}
      </span>
      {child && <span className="mt-[7.5px] h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--color-ink-faint)]" />}
      <span
        className={`min-w-0 flex-1 leading-relaxed ${
          child ? "text-[11px] text-[var(--color-ink-muted)]" : "text-[11.5px] text-[var(--color-ink)]"
        }`}
      >
        {step.text}
      </span>
      <span className="flex shrink-0 items-center gap-1 pt-px">
        <button
          type="button"
          title={t("就这一步追问 AI")}
          onClick={(event) => {
            event.stopPropagation();
            onAsk();
          }}
          className="rounded px-1 text-[10px] text-[var(--color-ink-faint)] opacity-0 transition-opacity hover:text-[var(--color-accent)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          {t("追问")}
        </button>
        {lines && (
          <span className="mono px-1 text-[9.5px] tabular-nums text-[var(--color-ink-faint)] transition-colors group-hover:text-[var(--color-accent)]">
            {lines[0] === lines[1] ? `L${lines[0]}` : `L${lines[0]}–${lines[1]}`}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The source code preview floating above the canvas on the left side of the drawer. The drawer is only a few hundred pixels wide, while the canvas on the left
 * It just happened to be free when looking at the details, and borrowing that space was much easier to read than squeezing a small window in the drawer.
 */
function SourcePreview({ source, hover }: { source: LoadedSource; hover: HoverState }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const total = hover.range[1] - hover.range[0] + 1;
  const [shown, setShown] = useState(() => Math.min(total, PREVIEW_MAX_LINES));
  const [top, setTop] = useState(hover.rect.top);
  const gap = 10;
  const available = hover.drawerLeft - gap - 12;
  const part = source.range(hover.range[0], hover.range[0] + shown - 1);
  const hidden = total - part.lines.length;

  // Line height varies with font size settings, measured quantity: if it exceeds the available height, measure by trimming the extra lines according to the actual line height
  // Once (after 'there are N more lines' appears, it will rise a bit more). All of this happens before drawing, so the intermediate state cannot be seen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const maxHeight = window.innerHeight - PREVIEW_TOP - PREVIEW_BOTTOM_MARGIN;
    const overflow = el.offsetHeight - maxHeight;
    if (overflow > 0 && shown > 1) {
      const lineHeight = el.querySelector<HTMLElement>("[data-line]")?.offsetHeight || 18;
      setShown(Math.max(1, shown - Math.ceil(overflow / lineHeight)));
      return;
    }
    const maxTop = Math.max(PREVIEW_TOP, window.innerHeight - el.offsetHeight - PREVIEW_BOTTOM_MARGIN);
    setTop(Math.min(Math.max(hover.rect.top - 6, PREVIEW_TOP), maxTop));
  }, [hover, shown]);

  if (available < PREVIEW_MIN_WIDTH) return null;

  return createPortal(
    <div
      ref={ref}
      className="anim-fade pointer-events-none fixed z-50 overflow-hidden rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] shadow-2xl"
      style={{
        top,
        right: window.innerWidth - hover.drawerLeft + gap,
        maxWidth: Math.min(640, available),
        minWidth: PREVIEW_MIN_WIDTH,
      }}
    >
      <div className="mono flex items-center gap-2 border-b border-[var(--color-line)] px-2.5 py-1 text-[10px] text-[var(--color-ink-faint)]">
        <span className="truncate">{source.slice.path}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          L{hover.range[0]}–{hover.range[1]}
        </span>
      </div>
      <div className="overflow-hidden">
        <CodeBlock lines={part.lines} tokens={part.tokens} firstLine={part.first} />
      </div>
      {hidden > 0 && (
        <div className="border-t border-[var(--color-line)] px-2.5 py-1 text-[10px] text-[var(--color-ink-faint)]">
          {t("还有 {count} 行，点击在源码标签中查看", { count: hidden })}
        </div>
      )}
    </div>,
    document.body,
  );
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      aria-label={loading ? t("正在重新生成伪代码") : t("重新生成伪代码")}
      title={loading ? t("正在重新生成…") : t("重新生成（同时刷新 AI 摘要）")}
      className="flex h-5 w-5 items-center justify-center rounded text-[14px] leading-none text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
    >
      <span className={loading ? "animate-spin" : ""}>↻</span>
    </button>
  );
}

function InlineStatus({ label }: { label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5 px-2.5 py-2 text-[11px] text-[var(--color-ink-muted)]">
      <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
      {label}
    </div>
  );
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 rounded border border-[var(--color-accent)]/40 px-2 py-1 text-[10.5px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10"
    >
      {children}
    </button>
  );
}

/** The serial number column has a fixed width according to the number of digits (1ch under a mono font equals one digit), and a single-digit list does not leave space for two digits. */
export function stepMarkerWidth(count: number): string {
  return count >= 10 ? "w-[2ch]" : "w-[1ch]";
}

export function hasLines(steps: readonly PseudocodeStepDto[] | null | undefined): boolean {
  return Boolean(steps?.some((step) => step.lines || step.children.some((child) => child.lines)));
}
