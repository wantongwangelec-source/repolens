import type { SearchHitDto } from "@repolens/core/types";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { msg, useT } from "../i18n";
import { ALL_VISIBLE_ROLES, SOURCE_ONLY_ROLES, useAppStore } from "../store/useAppStore";

const KIND_LABELS: Record<string, string> = {
  file: msg("文件"),
  symbol: msg("符号"),
  package: msg("包"),
  directory: msg("目录"),
};

/**
 * ⌘K Command Palette.
 *
 * The 'organization' strategy requires that all intentions of 'I want to go somewhere' receive an entry point,
 * Instead of scattering a dozen or so navigation buttons across the interface.
 */
export function CommandPalette() {
  const t = useT();
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const reveal = useAppStore((s) => s.reveal);
  const showNoise = useAppStore((s) => s.showNoise);
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => `${s.repoRevision}.${s.indexRevision}`);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHitDto[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setCursor(0);
      // Wait until the drawer has finished mounting before focusing, otherwise autoFocus will be swallowed by the animation.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, repoId, repoRevision]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      return;
    }
    // Input debounce: search goes through FTS, fast but there's no need to hit every key
    const timer = window.setTimeout(() => {
      void api
        // The search needs to use the same set of noise rules as the graph, otherwise the test files deliberately hidden on the graph
        // It will flood back from the search results, with almost all of the top 20 being *.test.ts
        .search(trimmed, 24, (showNoise ? ALL_VISIBLE_ROLES : SOURCE_ONLY_ROLES).join(","))
        .then((result) => {
          if (stale) return;
          setHits(result);
          setCursor(0);
        })
        .catch(() => {
          if (!stale) setHits([]);
        });
    }, 120);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [query, open, repoId, repoRevision, showNoise]);

  if (!open) return null;

  const commit = (hit: SearchHitDto | undefined) => {
    if (!hit) return;
    // Walk reveal instead of bare select: otherwise the diagram stops in place, and the things found only appear in the drawer,
    // One still has to drill down layer by layer to find its position in the structure.
    void reveal(hit.id);
    setOpen(false);
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-start justify-center bg-[var(--color-overlay)] pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((c) => Math.min(hits.length - 1, c + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (event.key === "Enter") {
              commit(hits[cursor]);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={t("搜索文件、符号、包…")}
          className="w-full border-b border-[var(--color-line)] bg-transparent px-4 py-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />

        <div className="thin-scroll max-h-[52vh] overflow-y-auto py-1">
          {hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11.5px] text-[var(--color-ink-faint)]">
              {query.trim().length === 0 ? t("输入关键词开始搜索") : t("没有匹配项")}
            </div>
          ) : (
            hits.map((hit, index) => (
              <button
                key={hit.id}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => commit(hit)}
                className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition-colors ${
                  index === cursor ? "bg-[var(--color-surface-3)]" : ""
                }`}
              >
                <span className="w-7 shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">
                  {t(KIND_LABELS[hit.kind] ?? hit.kind)}
                </span>
                {/*
                  收缩优先级：名字是主标识，路径是辅助信息，所以让路径先让位。
                  反过来（给路径 shrink-0）会把一串 agent-session-*.ts 全截成
                  `agent-sess…`，而右边的路径反倒完整显示。
                */}
                <span className="mono max-w-[58%] shrink-0 truncate text-[12px] text-[var(--color-ink)]">
                  {hit.label}
                </span>
                <Detail text={hit.detail} />
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-1.5 text-[10px] text-[var(--color-ink-faint)]">
          <span>↑↓ {t("选择")}</span>
          <span>⏎ {t("打开详情")}</span>
          <span>Esc {t("关闭")}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The auxiliary information on the right side of the search results, in the form `interface · packages/a/src/b.ts`.
 *
 * Path truncated from the head rather than the tail: lines hit by the same search in a monorepo often share
 * The `packages/x/src/` prefix, with an ellipsis at the end, cuts off the only part that can distinguish them, which is the tail segment.
 * The types of symbols in the prefix should be rendered separately, otherwise they will be cut off together.
 */
function Detail({ text }: { text: string }) {
  const cut = text.lastIndexOf(" · ");
  const kind = cut === -1 ? null : text.slice(0, cut);
  const path = cut === -1 ? text : text.slice(cut + 3);

  return (
    <span className="ml-auto flex min-w-0 items-baseline gap-1.5 pl-3 text-[10px] text-[var(--color-ink-faint)]">
      {kind && <span className="shrink-0">{kind}</span>}
      <span className="mono truncate-start min-w-0">{path}</span>
    </span>
  );
}
