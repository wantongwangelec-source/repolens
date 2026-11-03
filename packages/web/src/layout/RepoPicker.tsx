import type {
  LlmStatusDto,
  OverviewDto,
  RepoEntry,
  RepoScanTaskDto,
  RepoStatus,
  ScanPhase,
} from "@repolens/core/types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { msg, t, translateMessage, useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";

const STATUS_HINT: Record<Exclude<RepoStatus, "ok">, string> = {
  "index-missing": msg("索引已被删除，需要重新扫描"),
  "root-missing": msg("目录已不存在"),
};

const PHASE_LABELS: Record<ScanPhase, string> = {
  discover: msg("发现文件"),
  parse: msg("解析语法"),
  resolve: msg("解析依赖"),
  link: msg("链接图谱"),
  rollup: msg("聚合指标"),
  enrich: msg("生成 AI 语义"),
  index: msg("建立索引"),
};

const TOOLTIP_WIDTH = 420;
const TOOLTIP_GAP = 8;
const VIEWPORT_MARGIN = 12;
const COMPLETED_SCAN_DISMISS_MS = 3_000;

/** After the dropdown menu is closed, the overview that has been read is still retained; rescanning will change lastOpenedAt, thereby naturally invalidating it. */
const overviewCache = new Map<string, OverviewDto>();
const overviewRequests = new Map<string, Promise<OverviewDto>>();

/**
 * Warehouse selector.
 *
 * Even with a single repository, the dropdown entry is retained, because adding repositories and scanning progress are all placed here. Directory path
 * Not filled out via the webpage, but invoked by the local service to call up the system directory picker, avoiding the opening of arbitrary path reading.
 */
export function RepoPicker() {
  useT();
  const repos = useAppStore((s) => s.repos);
  const repoId = useAppStore((s) => s.repoId);
  const overview = useAppStore((s) => s.overview);
  const open = useAppStore((s) => s.repoPickerOpen);
  const setOpen = useAppStore((s) => s.setRepoPickerOpen);
  const refreshRepos = useAppStore((s) => s.refreshRepos);
  const switchRepo = useAppStore((s) => s.switchRepo);
  const [scanTask, setScanTask] = useState<RepoScanTaskDto | null>(null);
  const [picking, setPicking] = useState(false);
  const [startingRepoId, setStartingRepoId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const completedRef = useRef<string | null>(null);
  const scanKindRef = useRef<"add" | "rescan" | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);

  // Click outside to close. Hang on the document and use capture, otherwise when clicking on the canvas
  // React Flow will intercept the event first, so the dropdown cannot be closed.
  useEffect(() => {
    if (!open) return;
    // The branch may have just been switched in the terminal; each expansion reloads the list to avoid continuously showing the initial screen cache.
    void refreshRepos().catch(() => {
      // The existing list can still be used, and failure to refresh should not prevent repository switching.
    });
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, refreshRepos, setOpen]);

  const finishScan = useCallback(
    async (task: RepoScanTaskDto) => {
      if (!task.repo || completedRef.current === task.id) return;
      completedRef.current = task.id;
      try {
        const wasKnown = repos.some((repo) => repo.id === task.repo?.id || repo.root === task.root);
        const rescan = scanKindRef.current === "rescan" || (scanKindRef.current === null && wasKnown);
        await refreshRepos();
        if (rescan) {
          // The index content of the current repository has changed, and the graph data needs to be cleared and reloaded; background rescan
          // Other warehouses will maintain the current view and will not suddenly switch the user away.
          if (task.repo.id === repoId) {
            setOpen(false);
            await switchRepo(task.repo.id, true);
          }
        } else {
          setOpen(false);
          await switchRepo(task.repo.id);
        }
        scanKindRef.current = null;
      } catch (err) {
        completedRef.current = null;
        setScanError(t("仓库已扫描，但打开失败：{error}", { error: (err as Error).message }));
      }
    },
    [refreshRepos, repoId, repos, setOpen, switchRepo],
  );

  // After the page refreshes or the menu closes, the task continues on the server. When remounted, the unfinished task is resumed.
  // Avoid making the interface look like it suddenly vanishes.
  useEffect(() => {
    let disposed = false;
    void api.repoScans().then(({ tasks }) => {
      if (disposed) return;
      const running = tasks.find((task) => task.status === "running");
      if (running) {
        scanKindRef.current = repos.length === 0
          ? null
          : repos.some((repo) => repo.root === running.root) ? "rescan" : "add";
        setScanTask(running);
      }
    }).catch(() => {
      // Restoring the state enhances capabilities and does not affect normal browsing.
    });
    return () => {
      disposed = true;
    };
  }, [repos]);

  useEffect(() => {
    if (scanTask?.status !== "running") return;
    let disposed = false;
    let polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      void api.repoScan(scanTask.id).then((next) => {
        if (disposed) return;
        setScanTask(next);
        if (next.status === "completed") void finishScan(next);
        if (next.status === "failed") setScanError(next.error ? translateMessage(next.error) : t("扫描失败"));
      }).catch((err: Error) => {
        if (!disposed) setScanError(t("无法读取扫描进度：{error}", { error: err.message }));
      }).finally(() => {
        polling = false;
      });
    };
    void poll();
    const timer = window.setInterval(poll, 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [finishScan, scanTask?.id, scanTask?.status]);

  // Leave three seconds in the success state for the user to confirm the result, then automatically collapse. Determine by task ID,
  // To prevent the user from starting a new task within these three seconds, only to have the timer of the previous task cleared.
  useEffect(() => {
    if (scanTask?.status !== "completed") return;
    const completedId = scanTask.id;
    const timer = window.setTimeout(() => {
      setScanTask((current) => current?.id === completedId ? null : current);
    }, COMPLETED_SCAN_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [scanTask?.id, scanTask?.status]);

  const addRepository = async () => {
    setPicking(true);
    setScanError(null);
    try {
      const result = await api.pickAndScanRepo();
      if (result.cancelled || !result.task) return;
      completedRef.current = null;
      scanKindRef.current = "add";
      setScanTask(result.task);
      if (result.task.status === "completed") await finishScan(result.task);
      if (result.task.status === "failed") setScanError(result.task.error ? translateMessage(result.task.error) : t("扫描失败"));
    } catch (err) {
      setScanError((err as Error).message);
    } finally {
      setPicking(false);
    }
  };

  // Both the welcome page and the native menu initiate 'Add Repository' through the store: expand the dropdown to see the scanning progress,
  // Pop up the directory selection again. Only expand while selecting or scanning, do not initiate repeatedly.
  const addRepoRequest = useAppStore((s) => s.addRepoRequest);
  const handleAddRequest = useRef<() => void>(() => {});
  useEffect(() => {
    handleAddRequest.current = () => {
      setOpen(true);
      if (!picking && scanTask?.status !== "running") void addRepository();
    };
  });
  useEffect(() => {
    if (addRepoRequest > 0) handleAddRequest.current();
  }, [addRepoRequest]);

  const rescanRepository = async (repo: RepoEntry) => {
    setScanError(null);
    setStartingRepoId(repo.id);
    try {
      completedRef.current = null;
      scanKindRef.current = "rescan";
      const task = await api.rescanRepo(repo.id);
      setScanTask(task);
      if (task.status === "completed") await finishScan(task);
      if (task.status === "failed") setScanError(task.error ? translateMessage(task.error) : t("扫描失败"));
    } catch (err) {
      scanKindRef.current = null;
      setScanError((err as Error).message);
    } finally {
      setStartingRepoId(null);
    }
  };

  // When scanning, the repository name comes from the index, which is more accurate than the directory name in the manifest (the package name in a monorepo may
  // Different from the directory name), so it is preferred.
  const label = overview?.repoName ?? repos.find((r) => r.id === repoId)?.name ?? "RepoLens";

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex max-w-[220px] items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-semibold transition-colors hover:bg-[var(--color-surface-3)]"
        title={t("切换或添加仓库")}
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[9px] text-[var(--color-ink-faint)]">▾</span>
      </button>

      {open && (
        <div className="anim-fade absolute left-0 top-full z-50 mt-1 w-[360px] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] shadow-xl">
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {repos.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                active={repo.id === repoId}
                activeOverview={repo.id === repoId ? overview : null}
                scanning={scanTask?.status === "running" || startingRepoId !== null}
                scanningThisRepo={scanTask?.status === "running" && scanTask.root === repo.root}
                starting={startingRepoId === repo.id}
                onRescan={() => void rescanRepository(repo)}
              />
            ))}
          </div>

          <div className="border-t border-[var(--color-line)] p-2">
            {scanTask && <ScanProgress task={scanTask} />}
            {scanError && (
              <div
                className="mb-2 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-2.5 py-2 text-[10px] leading-relaxed text-[var(--color-danger)]"
                role="alert"
              >
                {scanError}
              </div>
            )}
            <button
              type="button"
              disabled={picking || scanTask?.status === "running"}
              onClick={() => void addRepository()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] px-3 py-2 text-[11px] font-medium text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderPlusIcon />
              {picking
                ? t("等待选择目录…")
                : scanTask?.status === "running"
                  ? t("正在扫描仓库…")
                  : t("添加本地仓库")}
            </button>
            <p className="mt-1.5 px-1 text-[9.5px] leading-relaxed text-[var(--color-ink-faint)]">
              {t("选择代码目录后会自动建立索引；扫描只在本机进行。")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ScanProgress({ task }: { task: RepoScanTaskDto }) {
  useT();
  const percent = Math.round(task.progress * 100);
  const phase = task.phase ? t(PHASE_LABELS[task.phase]) : t("准备扫描");
  const count = task.total > 1 ? `${task.done.toLocaleString()} / ${task.total.toLocaleString()}` : null;

  return (
    <div className="mb-2 rounded-md bg-[var(--color-surface-3)] px-2.5 py-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] font-medium">
          {task.status === "completed" ? t("扫描完成") : task.status === "failed" ? t("扫描失败") : t("正在扫描 {name}", { name: task.name })}
        </span>
        <span className="mono shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">
          {task.status === "completed" ? "100%" : `${percent}%`}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface)]">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            task.status === "failed" ? "bg-[var(--color-danger)]" : "bg-[var(--color-accent)]"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between gap-3 text-[9.5px] text-[var(--color-ink-faint)]">
        <span>{phase}</span>
        {count && <span className="mono tabular-nums">{count}</span>}
      </div>
    </div>
  );
}

function FolderPlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="block h-3.5 w-3.5"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.75 4.5h4l1.2 1.35h7.3v6.4a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1V4.5Z" />
      <path d="M8 8v3M6.5 9.5h3" />
    </svg>
  );
}

function RepoRow({
  repo,
  active,
  activeOverview,
  scanning,
  scanningThisRepo,
  starting,
  onRescan,
}: {
  repo: RepoEntry;
  active: boolean;
  activeOverview: OverviewDto | null;
  scanning: boolean;
  scanningThisRepo: boolean;
  starting: boolean;
  onRescan: () => void;
}) {
  useT();
  const switchRepo = useAppStore((s) => s.switchRepo);
  const forget = useAppStore((s) => s.forgetRepo);
  const setOpen = useAppStore((s) => s.setRepoPickerOpen);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const usable = repo.status === "ok";

  const showOverview = () => {
    setHovered(true);
  };

  return (
    <div
      ref={rowRef}
      onMouseEnter={showOverview}
      onMouseLeave={() => setHovered(false)}
      onFocus={showOverview}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false);
      }}
      className={`group flex items-center gap-2 px-2 py-1.5 ${
        usable ? "hover:bg-[var(--color-surface-3)]" : ""
      }`}
    >
      <button
        type="button"
        disabled={!usable}
        onClick={() => {
          setOpen(false);
          void switchRepo(repo.id);
        }}
        className={`flex min-w-0 flex-1 flex-col items-start text-left ${
          usable ? "" : "cursor-not-allowed opacity-45"
        }`}
        aria-describedby={hovered ? `repo-overview-${repo.id}` : undefined}
      >
        <span className="flex w-full items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              background: active
                ? "var(--color-accent)"
                : usable
                  ? "var(--color-line-strong)"
                  : "var(--color-danger)",
            }}
          />
          <span className="min-w-0 truncate text-[12px] font-medium">{repo.name}</span>
          {repo.branch && (
            <span
              className="mono max-w-[120px] shrink-0 truncate rounded bg-[var(--color-surface-3)] px-1 py-px text-[9.5px] font-normal text-[var(--color-accent)]"
              title={t("当前分支：{branch}", { branch: repo.branch })}
            >
              {repo.branch}
            </span>
          )}
          {!usable && (
            <span className="shrink-0 text-[10px] text-[var(--color-danger)]">
              {t(STATUS_HINT[repo.status as Exclude<RepoStatus, "ok">])}
            </span>
          )}
        </span>
        <span className="mono w-full truncate pl-3 text-[10px] text-[var(--color-ink-faint)]">
          {shorten(repo.root)}
        </span>
      </button>

      <button
        type="button"
        disabled={scanning || repo.status === "root-missing"}
        onClick={(event) => {
          event.stopPropagation();
          setError(null);
          onRescan();
        }}
        className={`shrink-0 rounded px-1 py-0.5 text-[10px] text-[var(--color-ink-faint)] transition-[color,background-color,opacity] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] disabled:cursor-not-allowed ${
          hovered ? "visible opacity-100" : "invisible opacity-0"
        }`}
        title={repo.status === "root-missing" ? t("仓库目录不存在，无法扫描") : t("增量重新扫描仓库")}
      >
        {starting ? t("启动中…") : scanningThisRepo ? t("扫描中…") : t("重新扫描")}
      </button>

      {/*
        移除只动清单，不动仓库和索引，所以不需要二次确认——
        代价是重新 scan 一次，而误删的唯一后果是从这个列表里消失。
      */}
      {!active && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setError(null);
            void forget(repo.id).catch((err: Error) => setError(err.message));
          }}
          className={`shrink-0 rounded px-1 py-0.5 text-[10px] text-[var(--color-ink-faint)] transition-opacity hover:text-[var(--color-danger)] ${
            hovered ? "visible opacity-100" : "invisible opacity-0"
          }`}
          title={t("从清单移除（不删除仓库和索引）")}
        >
          {t("移除")}
        </button>
      )}

      {error !== null && <span className="text-[10px] text-[var(--color-danger)]">{error}</span>}

      {hovered && (
        <RepoOverviewTooltip
          id={`repo-overview-${repo.id}`}
          repo={repo}
          activeOverview={activeOverview}
          anchor={rowRef}
        />
      )}
    </div>
  );
}

type OverviewLoadState =
  | { status: "loading" }
  | { status: "ready"; overview: OverviewDto }
  | { status: "error"; message: string };

function RepoOverviewTooltip({
  id,
  repo,
  activeOverview,
  anchor,
}: {
  id: string;
  repo: RepoEntry;
  activeOverview: OverviewDto | null;
  anchor: React.RefObject<HTMLDivElement | null>;
}) {
  useT();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState<OverviewLoadState>(() => {
    if (activeOverview) return { status: "ready", overview: activeOverview };
    const cached = overviewCache.get(overviewCacheKey(repo));
    return cached ? { status: "ready", overview: cached } : { status: "loading" };
  });
  const [position, setPosition] = useState({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, width: TOOLTIP_WIDTH });

  const placeTooltip = useCallback(() => {
    const row = anchor.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const width = Math.min(TOOLTIP_WIDTH, Math.max(240, window.innerWidth - VIEWPORT_MARGIN * 2));
    const fitsRight = rect.right + TOOLTIP_GAP + width <= window.innerWidth - VIEWPORT_MARGIN;
    const preferredLeft = fitsRight
      ? rect.right + TOOLTIP_GAP
      : rect.left - TOOLTIP_GAP - width;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, preferredLeft),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    const height = tooltipRef.current?.getBoundingClientRect().height ?? 0;
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.top),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    );
    setPosition((current) =>
      current.left === left && current.top === top && current.width === width
        ? current
        : { left, top, width },
    );
  }, [anchor]);

  useEffect(() => {
    if (repo.status !== "ok") return;
    if (activeOverview) {
      overviewCache.set(overviewCacheKey(repo), activeOverview);
      setLoad({ status: "ready", overview: activeOverview });
      return;
    }

    const key = overviewCacheKey(repo);
    const cached = overviewCache.get(key);
    if (cached) {
      setLoad({ status: "ready", overview: cached });
      return;
    }

    let disposed = false;
    let request = overviewRequests.get(key);
    if (!request) {
      request = api.repoOverview(repo.id);
      overviewRequests.set(key, request);
      // No need for finally: the derived Promise returned by finally will reject again if the request fails,
      // Even if the original request has been caught below, the browser will still report an unhandled rejection once.
      void request.then(
        () => overviewRequests.delete(key),
        () => overviewRequests.delete(key),
      );
    }
    void request
      .then((next) => {
        overviewCache.set(key, next);
        if (!disposed) setLoad({ status: "ready", overview: next });
      })
      .catch((err: Error) => {
        if (!disposed) setLoad({ status: "error", message: err.message });
      });
    return () => {
      disposed = true;
    };
  }, [activeOverview, repo]);

  useLayoutEffect(() => {
    placeTooltip();
  }, [load, placeTooltip]);

  useEffect(() => {
    const update = () => placeTooltip();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [placeTooltip]);

  const content = repo.status === "ok" ? load : null;

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="pointer-events-none fixed z-[80] rounded-lg border border-[var(--color-accent)]/20 bg-[var(--color-surface)]/95 px-3 py-2.5 shadow-xl backdrop-blur"
      style={position}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-ink)]">{repo.name}</span>
        <span className="shrink-0 text-[9px] uppercase tracking-wider text-[var(--color-accent)]">
          {t("AI 仓库概览")}
        </span>
      </div>
      <div className="mono mt-1 break-all text-[9px] leading-relaxed text-[var(--color-ink-faint)]">
        {repo.root}
      </div>

      {repo.status !== "ok" ? (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-danger)]">
          {t(STATUS_HINT[repo.status])}
        </p>
      ) : content?.status === "ready" ? (
        <>
          <div className="mt-1.5 text-[9.5px] text-[var(--color-ink-faint)]">
            {overviewFacts(content.overview)}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            {content.overview.summary ??
              missingOverviewMessage(
                content.overview.summaryUnavailableReason,
                content.overview.llm,
              )}
          </p>
        </>
      ) : content?.status === "error" ? (
        <p className="mt-2 break-words text-[11px] leading-relaxed text-[var(--color-danger)]">
          {t("无法读取仓库概览：{error}", { error: content.message })}
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">{t("正在读取仓库概览…")}</p>
      )}
    </div>,
    document.body,
  );
}

function overviewCacheKey(repo: RepoEntry): string {
  return `${repo.id}:${repo.lastOpenedAt}`;
}

function overviewFacts(overview: OverviewDto): string {
  const languages = overview.languages
    .slice(0, 3)
    .map((item) => item.language)
    .join(" / ");
  return [
    t("{count} 个文件", { count: overview.totals.files.toLocaleString("en-US") }),
    t("{count} 行代码", { count: overview.totals.loc.toLocaleString("en-US") }),
    languages || null,
  ].filter(Boolean).join(" · ");
}

function missingOverviewMessage(
  scanReason: string | null | undefined,
  llm: LlmStatusDto | null | undefined,
): string {
  if (scanReason) return t("仓库概览未生成：{reason}。重新扫描后会再次尝试。", { reason: translateMessage(scanReason) });
  if (llm?.enabled === false) return t("当前仓库扫描时未启用 AI，因此没有生成仓库概览。");
  if (llm && !llm.available && llm.reason) return t("仓库概览未生成：{reason}。重新扫描后会再次尝试。", { reason: translateMessage(llm.reason) });
  return t("这个索引尚未生成仓库概览，通常是旧索引或上次扫描时模型不可用；重新扫描后会再次尝试。");
}

/**
 * Abbreviate the home directory as `~`.
 *
 * The frontend can't access $HOME, but the repository paths are almost all under the home directory, the `/Users/<name>/` part
 * It's the same for every line, purely squeezing out the latter part that actually makes a difference. According to platform conventions, you can deduce the first two paragraphs in reverse.
 */
function shorten(path: string): string {
  const match = /^(\/(?:Users|home)\/[^/]+)(\/.*)?$/.exec(path);
  return match ? `~${match[2] ?? ""}` : path;
}
