import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useChatStore, type ChatAttachment } from "../store/useChatStore";

const MAX_QUOTE_CHARS = 2_000;

interface Anchor {
  x: number;
  y: number;
  quote: Extract<ChatAttachment, { kind: "quote" }>;
}

/**
 * After selecting a piece of text in the details, a 'Follow-up Question' button will appear.
 *
 * When the selection falls on a source code line, also note the line number and the file it belongs to, so that the server can use them to fetch those few lines of the original text.
 * Submit it all to the model together—users no longer need to explain 'which part I am talking about'.
 */
export function SelectionAsk({ container, nodeId }: { container: HTMLElement | null; nodeId: string | null }) {
  const t = useT();
  const attach = useChatStore((s) => s.attach);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    if (!container) return;
    const update = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return setAnchor(null);
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return setAnchor(null);
      const text = selection.toString().trim();
      if (text.length < 2) return setAnchor(null);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      setAnchor({ x: last.right, y: last.bottom, quote: quoteFrom(range, text, nodeId) });
    };
    const onUp = () => window.requestAnimationFrame(update);
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setAnchor(null);
    };
    const hide = () => setAnchor(null);
    container.addEventListener("mouseup", onUp);
    container.addEventListener("keyup", onUp);
    container.addEventListener("scroll", hide, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      container.removeEventListener("mouseup", onUp);
      container.removeEventListener("keyup", onUp);
      container.removeEventListener("scroll", hide, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [container, nodeId]);

  if (!anchor) return null;

  const left = Math.min(Math.max(anchor.x - 30, 8), window.innerWidth - 76);
  const top = Math.min(anchor.y + 6, window.innerHeight - 32);

  return createPortal(
    <button
      type="button"
      // The selection cannot disappear when pressed, otherwise the reference will be lost when clicking.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        attach(anchor.quote);
        window.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
      className="anim-fade fixed z-50 flex items-center gap-1 rounded-full border border-[var(--color-accent)]/50 bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-accent)] shadow-lg transition-colors hover:bg-[var(--color-surface-3)]"
      style={{ left, top }}
    >
      <span aria-hidden="true">✦</span>{t("追问")}
    </button>,
    document.body,
  );
}

function quoteFrom(range: Range, text: string, nodeId: string | null): Anchor["quote"] {
  const start = lineOf(range.startContainer);
  const end = lineOf(range.endContainer);
  const file = elementOf(range.commonAncestorContainer)?.closest("[data-source-file]")?.getAttribute("data-source-file");
  const lines: [number, number] | null = start !== null && end !== null
    ? [Math.min(start, end), Math.max(start, end)]
    : null;
  const snippet = text.replace(/\s+/g, " ").slice(0, 16);
  const clipped = text.slice(0, MAX_QUOTE_CHARS);
  return {
    key: `quote:${hash(`${file ?? nodeId ?? ""}:${lines?.join("-") ?? ""}:${clipped}`)}`,
    kind: "quote",
    text: clipped,
    nodeId: lines && file ? file : nodeId,
    lines: lines && file ? lines : null,
    label: lines && file
      ? `L${lines[0]}${lines[1] === lines[0] ? "" : `–${lines[1]}`} · ${snippet}`
      : `“${snippet}${text.length > 16 ? "…" : ""}”`,
  };
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function lineOf(node: Node): number | null {
  const value = elementOf(node)?.closest("[data-line]")?.getAttribute("data-line");
  const line = value ? Number(value) : Number.NaN;
  return Number.isInteger(line) ? line : null;
}

function hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
