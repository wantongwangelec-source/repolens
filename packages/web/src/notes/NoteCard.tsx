import type { NoteDto } from "@repolens/core/types";
import { lazy, Suspense, useEffect, useState } from "react";
import { intlLocale, t, useT } from "../i18n";
import { formatLines, openNote, useNotesStore } from "../store/useNotesStore";

const ChatMarkdown = lazy(() => import("../ui/ChatMarkdown").then((module) => ({ default: module.ChatMarkdown })));

/** Fold it after exceeding so many characters first, so that one long answer in the list won't push the other notes out of view */
const COLLAPSE_CHARS = 280;

/** The position of the note; in the list, it is used to indicate 'which part of the code this note belongs to' */
function noteTargetLabel(note: NoteDto, withPath = true): string {
  const target = note.target;
  if (target.kind === "scope") return target.label;
  const parts = withPath ? [target.path] : [];
  if (target.symbol) parts.push(target.symbol);
  if (target.lines) parts.push(formatLines(target.lines));
  return parts.join(" · ") || t("整个文件");
}

export function NoteCard({
  note,
  showPath = true,
  onLocate,
}: {
  note: NoteDto;
  /** In the details of a single file, there is no need to repeat the file path */
  showPath?: boolean;
  /** By default, jump to the location of the note; if already in that file, the caller scrolls in place, null means there is nowhere to jump */
  onLocate?: (() => void) | null;
}) {
  useT();
  const remove = useNotesStore((s) => s.remove);
  const long = note.text.length > COLLAPSE_CHARS;
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const locate = onLocate === null ? null : onLocate ?? (note.nodeId !== null ? () => openNote(note) : null);
  const text = long && !expanded ? `${note.text.slice(0, COLLAPSE_CHARS).trimEnd()}…` : note.text;

  return (
    <article className="group rounded-md border border-[var(--color-note)]/25 bg-[var(--color-note)]/[0.06] px-2.5 py-2">
      <header className="mb-1 flex items-center gap-1.5 text-[10.5px]">
        <span aria-hidden="true" className="text-[var(--color-note)]">✎</span>
        {locate ? (
          <button
            type="button"
            onClick={locate}
            title={t("定位到这里")}
            className="mono min-w-0 truncate text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-accent)]"
          >
            {noteTargetLabel(note, showPath)}
          </button>
        ) : (
          <span
            className="mono min-w-0 truncate text-[var(--color-ink-faint)]"
            title={note.nodeId === null ? t("文件已删除或改名，无法定位") : undefined}
          >
            {noteTargetLabel(note, showPath)}
          </span>
        )}
        {note.stale && (
          <span
            title={t("记笔记之后文件改过，行号可能已经对不上")}
            className="shrink-0 rounded border border-[var(--color-warn)]/40 px-1 text-[9.5px] text-[var(--color-warn)]"
          >
            {t("文件已改动")}
          </span>
        )}
        {note.nodeId === null && (
          <span className="shrink-0 rounded border border-[var(--color-line)] px-1 text-[9.5px] text-[var(--color-ink-faint)]">
            {t("已失效")}
          </span>
        )}
        <time dateTime={note.createdAt} className="ml-auto shrink-0 text-[var(--color-ink-faint)]">
          {formatTime(note.createdAt)}
        </time>
        <button
          type="button"
          onClick={() => {
            if (!confirming) return setConfirming(true);
            setError(null);
            remove(note.id).catch((err: Error) => setError(err.message));
          }}
          className={`shrink-0 rounded px-1 transition-colors ${
            confirming
              ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
              : "text-[var(--color-ink-faint)] opacity-0 hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
          }`}
        >
          {confirming ? t("确认删除") : t("删除")}
        </button>
      </header>
      <Suspense fallback={<div className="whitespace-pre-wrap text-[12px] leading-relaxed">{text}</div>}>
        <ChatMarkdown content={text} streaming={false} />
      </Suspense>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-0.5 text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
        >
          {expanded ? t("收起") : t("展开全文")}
        </button>
      )}
      {note.question && (
        <p className="mt-1 truncate text-[10.5px] text-[var(--color-ink-faint)]" title={note.question}>
          {t("问：{question}", { question: note.question })}
        </p>
      )}
      {error && <p className="mt-1 text-[10.5px] text-[var(--color-warn)]">{t("删除失败：{error}", { error })}</p>}
    </article>
  );
}

/** List in reverse chronological order: the most recently noted is the most frequently revisited */
export function NoteList({
  notes,
  showPath = true,
  empty,
  onLocate,
}: {
  notes: NoteDto[];
  showPath?: boolean;
  empty: string;
  onLocate?: (note: NoteDto) => (() => void) | null | undefined;
}) {
  if (notes.length === 0) {
    return <p className="px-1 py-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">{empty}</p>;
  }
  return (
    <div className="space-y-2">
      {[...notes].reverse().map((note) => (
        <NoteCard key={note.id} note={note} showPath={showPath} onLocate={onLocate?.(note)} />
      ))}
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const time = date.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString(intlLocale(), { month: "numeric", day: "numeric" });
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}/${day}`;
}
