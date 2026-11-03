import type { NoteDto } from "@repolens/core/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t, useT } from "../i18n";
import { useChatStore, type ChatAttachment } from "../store/useChatStore";
import { formatLines, openNote, useNotesStore } from "../store/useNotesStore";

const MAX_NOTE_CHARS = 20_000;
const NODE_ID = /^(?:(?:sym|file):\d+|(?:dir|pkg):.+)$/;
const ROOT_SCOPE = "dir:.";

export interface NoteTarget {
  key: string;
  nodeId: string;
  lines: [number, number] | null;
  label: string;
  marker: string;
}

export interface NoteDraft {
  text: string;
  question: string | null;
  targets: NoteTarget[];
  /** Trigger position, the pop-up appears attached to it */
  rect: { left: number; top: number; bottom: number };
}

/**
 * Where an answer can be recorded: it's the context that comes along with the question, the more specific, the higher it is placed—
 * The referenced code lines, nodes, and the current view. Notes are only attached to specific code, not the repository root; walk-throughs are attached to the function at the top of the stack.
 */
export function noteTargets(attachments: ChatAttachment[], labels: Record<string, string>): NoteTarget[] {
  const quoted: NoteTarget[] = [];
  const nodes: NoteTarget[] = [];
  const views: NoteTarget[] = [];
  for (const item of attachments) {
    if (item.kind === "quote" && item.nodeId && NODE_ID.test(item.nodeId)) {
      const name = labels[item.nodeId] ?? (item.nodeId.startsWith("sym:") ? t("符号") : t("文件"));
      if (item.lines) {
        quoted.push({ key: `${item.nodeId}:${item.lines.join("-")}`, nodeId: item.nodeId, lines: item.lines, label: `${name} · ${formatLines(item.lines)}`, marker: "❝" });
      } else {
        nodes.push({ key: item.nodeId, nodeId: item.nodeId, lines: null, label: name, marker: "◇" });
      }
    } else if (item.kind === "node" && NODE_ID.test(item.id)) {
      nodes.push({ key: item.id, nodeId: item.id, lines: null, label: item.label, marker: "◇" });
    } else if (item.kind === "view") {
      const scope = item.ref.scope ?? null;
      const nodeId = item.ref.mode === "callgraph" && scope?.startsWith("call:")
        ? `sym:${scope.slice(5)}`
        : item.ref.mode === "walk"
          ? item.ref.walk?.at(-1)?.id ?? null
          : item.ref.mode === "structure" && scope !== null && NODE_ID.test(scope) ? scope : null;
      if (nodeId !== null && nodeId !== ROOT_SCOPE) {
        views.push({ key: nodeId, nodeId, lines: null, label: item.label, marker: "▦" });
      }
    }
  }
  const targets: NoteTarget[] = [];
  for (const target of [...quoted, ...nodes, ...views]) {
    if (!targets.some((existing) => existing.key === target.key)) targets.push(target);
  }
  return targets;
}

/**
 * The `[Name](node:ID)` in the answer uses the node ID from the scan period, which may point to something else after rescanning.
 * When saving as a note, only keep the name.
 */
export function noteTextFromAnswer(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\(node:[^)]+\)/g, (_, name: string) => (name.includes("`") ? name : `\`${name}\``));
}

/** Find the question corresponding to a certain answer from the chat history along with its context */
function sourceOf(messageId: number): { question: string | null; targets: NoteTarget[] } | null {
  const { messages, labels } = useChatStore.getState();
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const question = messages.slice(0, index).findLast((message) => message.role === "user") ?? null;
  return { question: question?.content ?? null, targets: noteTargets(question?.attachments ?? [], labels) };
}

/** When asking a question without including the code context (staying at the root of the repository, with nothing selected), there is no place to record the answer. */
export function hasNoteTarget(messageId: number): boolean {
  return (sourceOf(messageId)?.targets.length ?? 0) > 0;
}

export function draftFor(messageId: number, text: string, rect: NoteDraft["rect"]): NoteDraft | null {
  const source = sourceOf(messageId);
  if (!source || source.targets.length === 0) return null;
  return { text: text.slice(0, MAX_NOTE_CHARS), question: source.question, targets: source.targets, rect };
}

/**
 * After selecting text in the follow-up answer, 'Take Notes' pops up, and the 'Follow-up' in the details when selecting text is the same gesture.
 * Only recognize selections that fall within a single answer: if it spans two answers, it is unclear which context it should be recorded under.
 */
export function SelectionNote({ container }: { container: HTMLElement | null }) {
  useT();
  const [anchor, setAnchor] = useState<{ messageId: number; text: string; rect: NoteDraft["rect"] } | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);

  useEffect(() => {
    if (!container) return;
    const update = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return setAnchor(null);
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return setAnchor(null);
      const start = messageOf(range.startContainer);
      if (start === null || start !== messageOf(range.endContainer) || !hasNoteTarget(start)) return setAnchor(null);
      const text = selection.toString().trim();
      if (text.length < 2) return setAnchor(null);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const first = rects[0] ?? last;
      setAnchor({ messageId: start, text, rect: { left: last.right, top: first.top, bottom: last.bottom } });
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
  }, [container]);

  return (
    <>
      {anchor && !draft && createPortal(
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setDraft(draftFor(anchor.messageId, anchor.text, anchor.rect));
            window.getSelection()?.removeAllRanges();
            setAnchor(null);
          }}
          className="anim-fade fixed z-50 flex items-center gap-1 rounded-full border border-[var(--color-note)]/60 bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-note)] shadow-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style={{
            left: Math.min(Math.max(anchor.rect.left - 34, 8), window.innerWidth - 84),
            top: Math.min(anchor.rect.bottom + 6, window.innerHeight - 32),
          }}
        >
          <span aria-hidden="true">✎</span>{t("记笔记")}
        </button>,
        document.body,
      )}
      {draft && <SaveNotePopover draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
}

function messageOf(node: Node): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  const value = element?.closest("[data-note-source]")?.getAttribute("data-note-source");
  return value ? Number(value) : null;
}

type SaveState =
  | { phase: "picking" }
  | { phase: "saving"; target: NoteTarget }
  | { phase: "saved"; target: NoteTarget; note: NoteDto }
  | { phase: "failed"; target: NoteTarget; error: string };

/**
 * Choose a save location and save. If there is only one destination, there is no need to ask again, just save directly.
 * After saving, leave a note at the spot saying 'Saved to …', and clicking it will let you jump over to see it.
 */
export function SaveNotePopover({ draft, onClose }: { draft: NoteDraft; onClose: () => void }) {
  useT();
  const add = useNotesStore((s) => s.add);
  const [state, setState] = useState<SaveState>({ phase: "picking" });
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const save = (target: NoteTarget) => {
    setState({ phase: "saving", target });
    add({ nodeId: target.nodeId, lines: target.lines, text: draft.text, question: draft.question })
      .then((note) => setState({ phase: "saved", target, note }))
      .catch((err: Error) => setState({ phase: "failed", target, error: err.message }));
  };

  useEffect(() => {
    if (draft.targets.length === 1) save(draft.targets[0]!);
  }, []);

  useEffect(() => {
    if (state.phase !== "saved") return;
    const timer = window.setTimeout(onClose, 2600);
    return () => window.clearTimeout(timer);
  }, [state.phase]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // If it can fit, place it just below the trigger point; otherwise, flip it above. The follow-up panel is at the bottom of the screen, and most of the time it's the latter.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const below = draft.rect.bottom + 6;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, draft.rect.top - height - 6);
    const left = Math.min(Math.max(draft.rect.left - width / 2, 8), window.innerWidth - width - 8);
    setPosition({ left, top });
  }, [draft.rect, state.phase]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("记笔记")}
      className="anim-fade fixed z-50 w-64 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] p-1 text-[11px] shadow-xl"
      style={position ?? { left: -9999, top: -9999 }}
    >
      {state.phase === "picking" ? (
        <>
          <div className="px-2 pb-1 pt-0.5 text-[10px] text-[var(--color-ink-faint)]">{t("记到：")}</div>
          {draft.targets.map((target, index) => (
            <button
              key={target.key}
              type="button"
              autoFocus={index === 0}
              onClick={() => save(target)}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[var(--color-ink-muted)] outline-none transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)] focus-visible:bg-[var(--color-surface-3)] focus-visible:text-[var(--color-ink)]"
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-center text-[10px] text-[var(--color-ink-faint)]">{target.marker}</span>
              <span className="truncate">{target.label}</span>
            </button>
          ))}
        </>
      ) : state.phase === "saving" ? (
        <div className="px-2 py-1 text-[var(--color-ink-faint)]">{t("正在保存到 {target}…", { target: state.target.label })}</div>
      ) : state.phase === "saved" ? (
        <button
          type="button"
          onClick={() => {
            openNote(state.note);
            onClose();
          }}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-3)]"
        >
          <span className="text-[var(--color-success)]">✓</span>
          <span className="min-w-0 flex-1 truncate">{t("已记到 {target}", { target: state.target.label })}</span>
          <span className="shrink-0 text-[var(--color-accent)]">{t("查看")}</span>
        </button>
      ) : (
        <div className="px-2 py-1 text-[var(--color-warn)]">
          {t("保存失败：{error}", { error: state.error })}
          <button type="button" onClick={() => save(state.target)} className="ml-2 underline-offset-2 hover:underline">
            {t("重试")}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
