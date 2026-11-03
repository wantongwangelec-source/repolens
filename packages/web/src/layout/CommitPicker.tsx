import type { CommitDto } from "@repolens/core/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { type Locale, useLocale, useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Chevron } from "../ui/Chevron";

type Option = { commit: CommitDto; index: number } | { ref: string };

/**
 * Change comparison baseline: List the most recent commits that have modified the scan root, click to compare. Those not in the list
 * For earlier commits, other branches, HEAD~3, and similar notations, just enter them directly in the filter box.
 */
export function CommitPicker({
  base, baseCommit, busy, onPick,
}: {
  base: string;
  /** The submission corresponding to the current report; when the report is still the old baseline, it is null */
  baseCommit: string | null;
  busy: boolean;
  onPick: (ref: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const [commits, setCommits] = useState<CommitDto[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Every time I open it, it rereads: after scanning, it has been submitted again, it should also be in the list
  useEffect(() => {
    let cancelled = false;
    api.commits().then(
      (items) => !cancelled && setCommits(items),
      () => !cancelled && setCommits([]),
    );
    return () => {
      cancelled = true;
    };
  }, [repoId, repoRevision, open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const current = useMemo(() => {
    if (!commits) return null;
    const exact = baseCommit ? commits.find((c) => c.commit === baseCommit) : undefined;
    if (exact) return exact;
    if (base === "HEAD") return commits[0] ?? null;
    return commits.find((c) => c.commit.startsWith(base) || c.branches.includes(base) || c.tags.includes(base)) ?? null;
  }, [commits, base, baseCommit]);

  const typed = query.trim();
  const options = useMemo<Option[]>(() => {
    const needle = typed.toLowerCase();
    const matched = (commits ?? [])
      .map((commit, index) => ({ commit, index }))
      .filter(({ commit }) => needle === "" || commit.commit.startsWith(needle)
        || [commit.subject, commit.author, ...commit.branches, ...commit.tags].some((text) => text.toLowerCase().includes(needle)));
    const listed = matched.some(({ commit }) => commit.branches.includes(typed) || commit.tags.includes(typed)
      || (needle.length >= 4 && commit.commit.startsWith(needle)));
    return typed === "" || listed ? matched : [...matched, { ref: typed }];
  }, [commits, typed]);

  useEffect(() => {
    list.current?.querySelector(`[data-option="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const toggle = () => {
    setOpen(!open);
    setQuery("");
    setActive(0);
  };

  const pick = (option: Option) => {
    setOpen(false);
    // The latest one is HEAD: remember it as HEAD, future new commits will follow it.
    onPick("ref" in option ? option.ref : option.index === 0 ? "HEAD" : option.commit.commit);
  };

  return (
    <div ref={root} className="relative shrink-0 px-3 pt-2">
      <button
        type="button"
        onClick={toggle}
        aria-label={t("基线提交")}
        aria-expanded={open}
        title={current ? `${current.short} ${current.subject}` : base}
        className="flex w-full items-center gap-1.5 rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] px-1.5 py-[3px] text-left text-[11px] hover:border-[var(--color-line-strong)]"
      >
        <span className="shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">{t("对比")}</span>
        {current ? (
          <>
            <span className="mono shrink-0 text-[10.5px] text-[var(--color-accent)]">{current.short}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">{current.subject}</span>
          </>
        ) : (
          <span className="mono min-w-0 flex-1 truncate text-[var(--color-ink)]">{base}</span>
        )}
        {busy ? (
          <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">{t("对比中…")}</span>
        ) : (
          <span className={`shrink-0 text-[var(--color-ink-faint)] ${open ? "-rotate-90" : "rotate-90"}`}>
            <Chevron open={false} />
          </span>
        )}
      </button>

      {open && (
        <div className="anim-fade absolute left-3 right-3 top-full z-30 mt-1 overflow-hidden rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] shadow-xl">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((index) => Math.min(Math.max(index + step, 0), Math.max(options.length - 1, 0)));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const option = options[active];
                if (option) pick(option);
              } else if (event.key === "Escape") {
                // Don't let the global Esc also collapse the sidebar
                event.stopPropagation();
                setOpen(false);
              }
            }}
            spellCheck={false}
            placeholder={t("筛选提交，或输入分支、tag、HEAD~3")}
            className="w-full border-b border-[var(--color-line)] bg-transparent px-2.5 py-1.5 text-[11px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
          />
          <div ref={list} role="listbox" className="thin-scroll max-h-[min(420px,60vh)] overflow-y-auto py-1">
            {commits === null && <Empty>{t("读取提交记录…")}</Empty>}
            {commits?.length === 0 && typed === "" && <Empty>{t("这里不是 git 仓库，或者还没有提交。")}</Empty>}
            {options.map((option, index) => (
              <button
                key={"ref" in option ? "typed" : option.commit.commit}
                type="button"
                role="option"
                data-option={index}
                aria-selected={"ref" in option ? false : option.commit === current}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option)}
                className={`block w-full px-2.5 py-1.5 text-left ${index === active ? "bg-[var(--color-surface-raised)]" : ""}`}
              >
                {"ref" in option ? (
                  <TypedRef value={option.ref} />
                ) : (
                  <CommitRow commit={option.commit} latest={option.index === 0} selected={option.commit === current} locale={locale} />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CommitRow({ commit, latest, selected, locale }: { commit: CommitDto; latest: boolean; selected: boolean; locale: Locale }) {
  return (
    <>
      <div className="flex items-center gap-1.5 text-[11.5px]">
        <span className="mono shrink-0 text-[10.5px] text-[var(--color-accent)]">{commit.short}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">{commit.subject}</span>
        {selected && <span className="shrink-0 text-[11px] text-[var(--color-accent)]">✓</span>}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-[var(--color-ink-faint)]">
        <span className="shrink-0" title={new Date(commit.date).toLocaleString()}>{relativeTime(commit.date, locale)}</span>
        <span className="min-w-0 truncate">· {commit.author}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          {latest && <Chip color="var(--color-accent)">HEAD</Chip>}
          {commit.branches.map((name) => <Chip key={`b:${name}`} color="var(--color-ink-muted)">{name}</Chip>)}
          {commit.tags.map((name) => <Chip key={`t:${name}`} color="var(--color-success)">{name}</Chip>)}
        </span>
      </div>
    </>
  );
}

function TypedRef({ value }: { value: string }) {
  const t = useT();
  return (
    <>
      <div className="text-[11.5px] text-[var(--color-ink)]">
        {t("对比")} <span className="mono text-[var(--color-accent)]">{value}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--color-ink-faint)]">{t("任意提交号、分支、tag，或 HEAD~3 这类写法")}</div>
    </>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="mono max-w-[96px] truncate rounded bg-[var(--color-surface-2)] px-1 text-[9px]" style={{ color }}>
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 py-2 text-[11px] text-[var(--color-ink-faint)]">{children}</div>;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

function relativeTime(iso: string, locale: Locale): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "second");
}
