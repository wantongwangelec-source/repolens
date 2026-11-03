import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { modKey } from "../lib/shortcut";
import { useNotesStore } from "../store/useNotesStore";

/** The note request from the time the input box had already been focused */
let handledCompose = 0;

/**
 * Casual notes: jot down whatever you see, no need to ask AI first. Attach notes to nodes, store them according to the path,
 * Re-scanning and switching branches are still there; when files are changed, the line numbers that are marked may shift.
 */
export function QuickNote({ nodeId }: { nodeId: string }) {
  const t = useT();
  const add = useNotesStore((s) => s.add);
  const composeRequest = useNotesStore((s) => s.composeRequest);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  // When pressing N, the notes tab often hasn't loaded yet: after the input box is mounted, you also need to catch any requests that haven't been handled
  useEffect(() => {
    if (composeRequest <= handledCompose) return;
    handledCompose = composeRequest;
    ref.current?.focus();
  }, [composeRequest]);

  const save = () => {
    const value = text.trim();
    if (value === "" || busy) return;
    setBusy(true);
    setError(null);
    void add({ nodeId, lines: null, text: value, question: null })
      .then(() => setText(""))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mb-3">
      <textarea
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
        rows={3}
        placeholder={t("随手记一笔：这段在干什么、为什么这么写、要小心什么")}
        className="w-full resize-y rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2 py-1.5 text-[11.5px] leading-relaxed text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-line-strong)]"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || text.trim() === ""}
          onClick={save}
          className="rounded bg-[var(--color-note)]/90 px-2 py-0.5 text-[11px] font-medium text-[var(--color-canvas)] disabled:opacity-40"
        >
          {busy ? t("保存中…") : t("记下")}
        </button>
        <span className="text-[10px] text-[var(--color-ink-faint)]">{t("{shortcut} 保存 · 在哪都能按 N 记一笔", { shortcut: modKey("Enter") })}</span>
      </div>
      {error && <div className="mt-1 text-[11px] text-[var(--color-warn)]">{error}</div>}
    </div>
  );
}
