import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { useT } from "../i18n";
import { readPref, writePref } from "../lib/prefs";

type PanelSide = "left" | "right";

interface ResizablePanelOptions {
  side: PanelSide;
  /** Whether the sidebar is currently displayed determines whether it occupies width in useSidebarInset. */
  visible: boolean;
  storageKey: string;
  /** Use this width before the top bar has been measured to the aligned position */
  fallbackWidth: number;
  minWidth: number;
  maxWidth: number;
}

/**
 * The width of the sidebar before being dragged follows the top bar: the right edge of the left pane aligns with the group of buttons on the left side of the top bar (the last one is AI Follow-up),
 * Right column left edge aligned with the right-side operation area (the first one is 'code line'). Font size, language, and window width changes will all realign it.
 * The call graph and walkthrough view replaced the set of controls on the right. At this time, continue using the measurements from last time to prevent the drawer from jumping when switching views.
 */
const useSidebarAnchors = create<Record<PanelSide, number | null>>(() => ({ left: null, right: null }));

export function measureSidebarAnchors(header: HTMLElement): void {
  const box = header.getBoundingClientRect();
  const left = header.querySelector('[data-sidebar-anchor="left"]')?.getBoundingClientRect();
  const right = header.querySelector('[data-sidebar-anchor="right"]')?.getBoundingClientRect();
  const current = useSidebarAnchors.getState();
  const next = {
    left: left ? Math.round(left.right - box.left) : current.left,
    right: right ? Math.round(box.right - right.left) : current.right,
  };
  if (next.left !== current.left || next.right !== current.right) useSidebarAnchors.setState(next);
}

const useSidebarInsets = create<Record<PanelSide, number>>(() => ({ left: 0, right: 0 }));

/**
 * The sidebar currently covers how wide this side is; if not displayed, it is 0. The canvas can be dragged to avoid the overlay, so you don't need to worry about it.
 * The step list and source code of the walkthrough view are unavoidable; you have to make space according to this width.
 */
export function useSidebarInset(side: PanelSide): number {
  return useSidebarInsets((s) => s[side]);
}

/**
 * Sidebar width control. Dragging only updates the overlay itself and does not trigger a canvas re-layout. Only the dragged width is saved.
 * Preferences, double-click to restore default will clear it and realign it with the top bar.
 */
export function useResizablePanel(options: ResizablePanelOptions) {
  const { side, visible, storageKey, fallbackWidth, minWidth, maxWidth } = options;
  const anchored = useSidebarAnchors((s) => s[side]);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const clamp = useCallback(
    (value: number) => {
      const viewportMax = Math.max(minWidth, viewportWidth - 48);
      return Math.round(Math.min(Math.max(value, minWidth), Math.min(maxWidth, viewportMax)));
    },
    [maxWidth, minWidth, viewportWidth],
  );
  const [custom, setCustom] = useState(() => readStoredWidth(storageKey));
  const width = clamp(custom ?? anchored ?? fallbackWidth);
  const stopDraggingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    writePref(storageKey, custom === null ? null : String(custom));
  }, [storageKey, custom]);

  useEffect(() => {
    useSidebarInsets.setState({ [side]: visible ? width : 0 });
  }, [side, visible, width]);
  useEffect(() => () => useSidebarInsets.setState({ [side]: 0 }), [side]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => () => stopDraggingRef.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDraggingRef.current?.();

    const startX = event.clientX;
    const startWidth = width;
    const direction = side === "left" ? 1 : -1;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      setCustom(clamp(startWidth + (moveEvent.clientX - startX) * direction));
    };
    const stop = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      document.documentElement.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      stopDraggingRef.current = null;
    };
    stopDraggingRef.current = stop;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }, [clamp, side, width]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "Home") next = minWidth;
    if (event.key === "End") next = maxWidth;
    if (event.key === "ArrowLeft") next = width + (side === "left" ? -16 : 16);
    if (event.key === "ArrowRight") next = width + (side === "left" ? 16 : -16);
    if (next === null) return;
    event.preventDefault();
    setCustom(clamp(next));
  }, [clamp, maxWidth, minWidth, side, width]);

  return {
    width,
    minWidth,
    maxWidth: clamp(maxWidth),
    onPointerDown,
    onKeyDown,
    reset: () => setCustom(null),
  };
}

function readStoredWidth(storageKey: string): number | null {
  const parsed = Number.parseFloat(readPref(storageKey) ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function ResizablePanelHandle({
  side,
  label,
  width,
  minWidth,
  maxWidth,
  onPointerDown,
  onKeyDown,
  onReset,
}: {
  side: PanelSide;
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title={t("拖动调整宽度；双击恢复默认")}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={`group absolute top-0 z-40 flex h-full w-2 touch-none cursor-col-resize items-center justify-center outline-none ${
        side === "left" ? "-right-1" : "-left-1"
      }`}
    >
      <span className="h-full w-px bg-transparent transition-colors group-hover:bg-[var(--color-accent)] group-focus:bg-[var(--color-accent)] group-active:bg-[var(--color-accent)]" />
    </div>
  );
}
