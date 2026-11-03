import type { FindingSummaryDto, LensKind } from "@repolens/core/types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useNodeScope } from "../graph/useNodeScope";
import { msg, translateMessage, useLocale, useLocaleStore, useT } from "../i18n";
import { desktop } from "../lib/desktop";
import { writePref } from "../lib/prefs";
import { modKey } from "../lib/shortcut";
import { METRIC_LABELS } from "../ui/visual";
import { useAppStore, type MetricKey } from "../store/useAppStore";
import { useChatStore } from "../store/useChatStore";
import { RepoPicker } from "./RepoPicker";
import { measureSidebarAnchors } from "./ResizablePanelHandle";

const METRICS: MetricKey[] = ["loc", "complexity", "symbols"];

/**
 * Top bar.
 *
 * The 'deletion' strategy is the most critical here: there is too much that can be removed. In the end, only three categories are kept——
 * Where I am (warehouse name + breadcrumbs), what I am looking at (metrics), how much I am looking at (noise switch),
 * The rest all go into ⌘K or the filter drawer.
 *
 * No button wraps. When the window narrows, first truncate the statistics line after the repository name, then collapse the secondary text.
 * (See useCompactTopBar), the breadcrumbs are trimmed only at the end; the repository name itself always remains intact.
 */
export function TopBar() {
  const t = useT();
  const store = useAppStore();
  const overview = store.overview;
  const { headerRef, slackRef } = useCompactTopBar();

  // Before opening the warehouse, only warehouse selection and appearance settings are available, and the other controls have no objects to act on.
  if (store.noRepo) {
    return (
      <header className="app-topbar flex h-12 shrink-0 items-center gap-3 whitespace-nowrap border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3">
        <RepoPicker />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <FontSizeControl />
          <ThemeToggle />
          <LocaleToggle />
        </div>
      </header>
    );
  }

  return (
    <header
      ref={headerRef}
      className="app-topbar flex h-12 shrink-0 items-center gap-3 whitespace-nowrap border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3"
    >
      <div data-sidebar-anchor="left" className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => store.setTreeOpen(!store.treeOpen)}
          className={`flex h-7 w-7 items-center justify-center rounded-md border text-[13px] transition-colors ${
            store.treeOpen
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-[var(--color-line)] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)]"
          }`}
          title={t("结构树")}
        >
          <SidebarIcon />
        </button>

        <FindingsPill />
        <EntriesPill />
        <ChangesPill />
        <LlmPill />
      </div>

      {/*
        外层不能设 min-w-0：它的最小宽度就是仓库名的宽度，仓库名因此不会被挤掉。
        里层 w-0 flex-1 不向外层要最小宽度，只分剩下的空间。
      */}
      <div className="flex flex-1 items-baseline gap-2">
        <RepoPicker />
        <div ref={slackRef} className="flex w-0 flex-1 items-center gap-3 overflow-hidden">
          {overview && (
            <span
              data-topbar-optional="1"
              className="min-w-0 truncate text-[11px] text-[var(--color-ink-faint)]"
              title={t("只算参与分析的源码；连同测试、文档、配置共 {loc} 行", { loc: overview.totals.loc.toLocaleString("en-US") })}
            >
              {t("源码 {loc} 行", { loc: overview.totals.sourceLoc.toLocaleString("en-US") })} ·{" "}
              {overview.packages.length > 1 ? t("{count} 个包", { count: overview.packages.length }) : t("单包")} ·{" "}
              {overview.languages
                .slice(0, 3)
                .map((l) => l.language)
                .join(" / ")}
            </span>
          )}
          <LiveBadge />

          <Breadcrumb />
        </div>
      </div>

      {/*
        调用图模式下换掉整组控件而不是往后追加。指标、噪音、外部依赖
        在一张函数调用图上都无从谈起，留着它们只是让人误以为能用。
      */}
      <div className="flex shrink-0 items-center gap-1.5">
        {store.walk ? <WalkControls /> : store.callGraph ? <CallGraphControls /> : <StructureControls />}

        <button
          type="button"
          onClick={() => store.setPaletteOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
          title={t("搜索")}
          aria-label={t("搜索")}
        >
          <span data-topbar-optional="2">{t("搜索")}</span>
          <kbd className="mono rounded bg-[var(--color-surface-3)] px-1 text-[10px]">{modKey("K")}</kbd>
        </button>

        <FontSizeControl />
        <ThemeToggle />
        <LocaleToggle />

        <button
          type="button"
          onClick={() => store.setHelpOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-line)] text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
          title={t("手势说明")}
        >
          ?
        </button>
      </div>
    </header>
  );
}

const COMPACT_LEVELS = 2;

/**
 * When the top bar cannot fit everything, gradually hide secondary text, leaving only icons, numbers, and shortcuts: data-compact="1" hide
 * For data-topbar-optional="1", if it still doesn't fit, move on to "2", and even "2" should be collapsed.
 *
 * Determine based on measured width rather than window breakpoints: length of the repository name, whether the health check badge is present, interface language, font size,
 * The space reserved for the traffic light on the desktop side will change the required width. The slackRef section is allocated from the remaining space.
 * The statistical rows inside can be shortened at will, but the breadcrumb must be fully displayed — the × above it is to exit focus and the call graph.
 * The only entrance. When everything is folded up and still doesn't fit, the breadcrumb only truncates the text, leaving × behind.
 */
function useCompactTopBar() {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [slack, setSlack] = useState<HTMLDivElement | null>(null);
  // saved[i]: the width saved from level i to level i+1. It can only be measured once before and after collapsing, as the elements no longer occupy space after collapsing.
  const saved = useRef<number[]>([]);

  const fit = useCallback(() => {
    const last = header?.lastElementChild;
    if (!header || !slack || !last) return;
    const paddingRight = Number.parseFloat(getComputedStyle(header).paddingRight) || 0;
    const box = header.getBoundingClientRect();
    // The actual width that the content occupies, minus the remaining space of that cell, and then add back the original width of the breadcrumb.
    const need = () =>
      last.getBoundingClientRect().right +
      paddingRight -
      box.left -
      slack.getBoundingClientRect().width +
      breadcrumbWidth(slack);

    let level = Number(header.dataset["compact"] ?? 0);
    const setLevel = (next: number) => {
      level = next;
      if (next === 0) delete header.dataset["compact"];
      else header.dataset["compact"] = String(next);
    };

    while (level < COMPACT_LEVELS) {
      const before = need();
      if (before <= box.width) break;
      setLevel(level + 1);
      saved.current[level - 1] = before - need();
    }
    // Leave an 8px margin to avoid switching back and forth at the critical width.
    while (level > 0 && need() + (saved.current[level - 1] ?? Number.POSITIVE_INFINITY) + 8 <= box.width) {
      setLevel(level - 1);
    }
    measureSidebarAnchors(header);
  }, [header, slack]);

  // Switching modes, changing languages, or adding/removing breadcrumbs will all re-render the top bar. If the synchronization amount is set well before rendering, it won't flash.
  useLayoutEffect(() => fit());

  // Dragging the window, changing the font size, and loading the health check badge all do not go through the top bar rendering; they are triggered by size changes.
  useEffect(() => {
    if (!header) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(header);
    for (const child of header.children) observer.observe(child);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [header, fit]);

  return { headerRef: setHeader, slackRef: setSlack };
}

/** The width of the breadcrumbs when not truncated, along with the spacing between them and the previous statistics line; truncated characters are restored when squeezed, but each paragraph does not exceed its own max-width. */
function breadcrumbWidth(slack: HTMLElement): number {
  const crumbs = slack.querySelector<HTMLElement>("[data-breadcrumb]");
  if (!crumbs) return 0;
  let width = crumbs.getBoundingClientRect().width;
  for (const part of crumbs.children) {
    const label = part.firstElementChild;
    if (!label) continue;
    const current = part.getBoundingClientRect().width;
    const max = Number.parseFloat(getComputedStyle(part).maxWidth) || Number.POSITIVE_INFINITY;
    width += Math.min(max, current + label.scrollWidth - label.clientWidth) - current;
  }
  const previous = crumbs.previousElementSibling;
  const gap = previous && getComputedStyle(previous).display !== "none" ? Number.parseFloat(getComputedStyle(slack).columnGap) || 0 : 0;
  return width + gap;
}

function SidebarIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="block h-3.5 w-3.5"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

type Theme = "dark" | "light";
const THEME_STORAGE_KEY = "repolens-theme";
type FontSize = "small" | "medium" | "large";
const FONT_SIZE_STORAGE_KEY = "repolens-font-size";
const FONT_SIZES: ReadonlyArray<{ key: FontSize; label: string }> = [
  { key: "small", label: "100%" },
  { key: "medium", label: "115%" },
  { key: "large", label: "130%" },
];

function FontSizeControl() {
  const t = useT();
  const [fontSize, setFontSize] = useState<FontSize>(() => {
    const current = document.documentElement.dataset["fontSize"];
    return current === "medium" || current === "large" ? current : "small";
  });
  const index = FONT_SIZES.findIndex((option) => option.key === fontSize);
  const current = FONT_SIZES[index] ?? FONT_SIZES[0];

  const apply = (nextIndex: number) => {
    const next = FONT_SIZES[nextIndex];
    if (!next) return;
    document.documentElement.dataset.fontSize = next.key;
    writePref(FONT_SIZE_STORAGE_KEY, next.key);
    setFontSize(next.key);
  };

  return (
    <div
      className="flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--color-line)]"
      role="group"
      aria-label={t("字体大小")}
    >
      <button
        type="button"
        disabled={index === 0}
        onClick={() => apply(index - 1)}
        className="flex w-7 items-center justify-center text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-35"
        title={t("缩小字体")}
        aria-label={t("缩小字体")}
      >
        A−
      </button>
      <span
        data-topbar-optional="1"
        className="mono flex min-w-10 items-center justify-center border-x border-[var(--color-line)] bg-[var(--color-surface-2)] px-1 text-[9px] tabular-nums text-[var(--color-ink-faint)]"
        aria-live="polite"
      >
        {current?.label}
      </span>
      <button
        type="button"
        disabled={index === FONT_SIZES.length - 1}
        onClick={() => apply(index + 1)}
        className="flex w-7 items-center justify-center text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-35"
        title={t("放大字体")}
        aria-label={t("放大字体")}
      >
        A+
      </button>
    </div>
  );
}

function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset["theme"] === "light" ? "light" : "dark",
  );
  const target = theme === "dark" ? "light" : "dark";
  const label = target === "light" ? t("切换到浅色模式") : t("切换到深色模式");

  const toggle = () => {
    const next = target;
    const root = document.documentElement;
    root.dataset["theme"] = next;
    root.classList.toggle("dark", next === "dark");
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      next === "light" ? "#f3f5f8" : "#0b0d10",
    );
    writePref(THEME_STORAGE_KEY, next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-line)] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
      title={label}
      aria-label={label}
      aria-pressed={theme === "light"}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** Two languages are placed side by side, with the current one highlighted; each box is written in its own language, and you can find it even if you don't understand the other language */
function LocaleToggle() {
  const locale = useLocale();
  const setLocale = useLocaleStore((s) => s.setLocale);
  const options = [
    { key: "zh", label: "中", title: "切换到中文" },
    { key: "en", label: "EN", title: "Switch to English" },
  ] as const;
  // The line height takes the inner frame height (h-7 minus the top and bottom borders). The default 1.5 times line height is a decimal at 130% font size,
  // After rounding, the text tends to shift up by a little over 1px, and the top and bottom padding of the highlighted cell is noticeably uneven.
  return (
    <div
      className="flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--color-line)] leading-[26px]"
      role="group"
      aria-label={locale === "zh" ? "界面语言" : "Language"}
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          lang={option.key === "zh" ? "zh-CN" : "en"}
          aria-pressed={locale === option.key}
          onClick={() => setLocale(option.key)}
          title={option.title}
          className={`flex min-w-7 items-center justify-center px-1.5 text-[10.5px] transition-colors ${
            locale === option.key
              ? "bg-[var(--color-surface-3)] font-medium text-[var(--color-ink)]"
              : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 15.2A8 8 0 0 1 8.8 4a8 8 0 1 0 11.2 11.2Z" />
    </svg>
  );
}

function LlmPill() {
  const t = useT();
  const overview = useAppStore((s) => s.overview);
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const llm = overview?.llm;
  if (!llm) return null;
  const ready = llm.enabled && llm.available;
  const tokens = t("累计 {count} tokens", { count: llm.usage.totalTokens.toLocaleString("en-US") });
  const status = ready
    ? `${llm.model}${llm.interactiveModel ? ` / ${t("交互")} ${llm.interactiveModel}` : ""} · ${tokens}`
    : (llm.reason ? translateMessage(llm.reason) : t("纯结构模式"));
  // The desktop version can configure AI directly within the interface. When it's not ready, clicking it will take you to set it up first, rather than opening a chat window that can't respond.
  const configure = !ready && desktop !== null;
  const state = ready ? t("已就绪 · 追问") : configure ? t("未配置 · 设置") : t("未启用 · 追问");
  return (
    <button
      type="button"
      aria-pressed={chatOpen}
      onClick={() => {
        if (configure) setSettingsOpen(true);
        else if (chatOpen) setChatOpen(false);
        else useChatStore.getState().open();
      }}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
        ready
          ? "border-[var(--color-accent)]/40 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
          : "border-[var(--color-line)] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
      } ${chatOpen ? "bg-[var(--color-accent)]/10" : ""}`}
      title={configure ? `${status}\n${t("点击配置 AI")}` : `${status}\n${t("点击追问 AI（{shortcut}）", { shortcut: modKey("I") })}`}
    >
      AI<span data-topbar-optional="1">{` ${state}`}</span>
    </button>
  );
}

function StructureControls() {
  const t = useT();
  const store = useAppStore();
  return (
    <>
      <div data-sidebar-anchor="right" className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
        {METRICS.map((metric) => (
          <button
            key={metric}
            type="button"
            onClick={() => store.setMetric(metric)}
            className={`px-2.5 py-1 text-[11px] transition-colors ${
              store.metric === metric
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {t(METRIC_LABELS[metric])}
          </button>
        ))}
      </div>

      <Toggle
        active={store.showNoise}
        onClick={() => store.setShowNoise(!store.showNoise)}
        title={t("显示测试、配置、生成代码等非主干文件")}
      >
        {t("噪音")}
      </Toggle>

      <Toggle
        active={store.showExternal}
        onClick={() => store.setShowExternal(!store.showExternal)}
        title={t("把对第三方依赖的引用聚合成一个节点显示")}
      >
        {t("外部依赖")}
      </Toggle>

      <LensMenu />
    </>
  );
}

/** The value must pass through t() during rendering */
const LENS_OPTIONS: ReadonlyArray<{ key: LensKind; label: string; hint: string }> = [
  { key: "heat", label: msg("改动热度"), hint: msg("近 90 天改得越勤，条越长越红") },
  { key: "tests", label: msg("测试覆盖"), hint: msg("有测试走到的函数占几成") },
];

/**
 * Overlay a perspective on the diagram: where changes are frequent, where tests cover. When closed, the button only says 'Perspective',
 * Include the current perspective's name when it's open; write what each item means in the menu, so you don't have to select first and then guess.
 */
function LensMenu() {
  const t = useT();
  const lens = useAppStore((s) => s.lens);
  const setLens = useAppStore((s) => s.setLens);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = LENS_OPTIONS.find((option) => option.key === lens) ?? null;

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    // capture: When clicking on the canvas, React Flow will first consume the event, and the menu cannot be closed.
    const onDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onMenuKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      // Don't let the global Esc also collapse the sidebar
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const item = (key: LensKind | null, label: string, hint?: string) => (
    <button
      key={key ?? "none"}
      type="button"
      role="menuitemradio"
      aria-checked={lens === key}
      onClick={() => {
        setLens(key);
        close();
      }}
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left outline-none transition-colors hover:bg-[var(--color-surface-3)] focus-visible:bg-[var(--color-surface-3)]"
    >
      <span className="w-3 shrink-0 text-[11px] leading-[18px] text-[var(--color-accent)]">{lens === key ? "✓" : ""}</span>
      <span className="min-w-0 whitespace-normal">
        <span className="block text-[11.5px] leading-[18px] text-[var(--color-ink)]">{label}</span>
        {hint && <span className="block text-[10.5px] leading-snug text-[var(--color-ink-faint)]">{hint}</span>}
      </span>
    </button>
  );

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        title={t("在节点底边叠一条细条：改得勤不勤、测到了几成")}
        className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
          active
            ? "border-[var(--color-accent)] text-[var(--color-accent)]"
            : "border-[var(--color-line)] text-[var(--color-ink-faint)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
        }`}
      >
        {t("视角")}
        {active && <span data-topbar-optional="1">· {t(active.label)}</span>}
        <span aria-hidden="true" className="text-[8px] opacity-70">▼</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("视角")}
          onKeyDown={onMenuKey}
          className="anim-fade absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] py-1 shadow-xl"
        >
          <div className="whitespace-normal px-3 pb-1 pt-0.5 text-[10px] text-[var(--color-ink-faint)]">{t("给图上每个节点的底边叠一条细条")}</div>
          {LENS_OPTIONS.map((option) => item(option.key, t(option.label), t(option.hint)))}
          <div className="my-1 border-t border-[var(--color-line)]" />
          {item(null, t("不叠加"))}
        </div>
      )}
    </div>
  );
}

/** When monitoring a file, a dot lights up: AI is modifying the code alongside, and the diagrams and change pages update by themselves. */
function LiveBadge() {
  const t = useT();
  const status = useAppStore((s) => s.watchStatus);
  if (!status?.enabled) return null;
  const color = status.error ? "var(--color-warn)" : "var(--color-success)";
  return (
    <span
      data-topbar-optional="1"
      className="flex shrink-0 items-center gap-1 text-[10.5px]"
      style={{ color }}
      title={status.error
        ? t("文件监视出错：{error}", { error: translateMessage(status.error) })
        : t("盯着文件变化：改动后自动刷新结构索引")}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${status.refreshing ? "animate-pulse" : ""}`} style={{ background: color }} />
      {status.refreshing ? t("刷新中…") : t("实时")}
    </span>
  );
}

const DIRECTIONS = [
  { key: "callers", label: msg("调用方") },
  { key: "callees", label: msg("被调") },
  { key: "both", label: msg("双向") },
] as const;

function CallGraphControls() {
  const t = useT();
  const store = useAppStore();
  const mode = store.callGraph;
  if (!mode) return null;

  const showAmbiguous = store.confidence.includes("ambiguous");
  const omitted = store.subgraphs[mode.scopeId]?.truncated ?? 0;

  return (
    <>
      <div className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
        {DIRECTIONS.map((dir) => (
          <button
            key={dir.key}
            type="button"
            onClick={() => void store.setCallDirection(dir.key)}
            className={`px-2.5 py-1 text-[11px] transition-colors ${
              mode.direction === dir.key
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {t(dir.label)}
          </button>
        ))}
      </div>

      <div className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
        {[1, 2, 3].map((depth) => (
          <button
            key={depth}
            type="button"
            onClick={() => void store.setCallDepth(depth)}
            title={t("向外展开 {count} 跳", { count: depth })}
            className={`px-2 py-1 text-[11px] tabular-nums transition-colors ${
              mode.depth === depth
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {depth}
            <span data-topbar-optional="1">{t("跳", { count: depth })}</span>
          </button>
        ))}
      </div>

      <Toggle
        active={showAmbiguous}
        onClick={() =>
          void store.setConfidence(
            showAmbiguous ? ["exact", "likely"] : ["exact", "likely", "ambiguous"],
          )
        }
        title={t("同名候选不止一个的调用。默认隐藏，因为无法确定真正指向哪一个")}
      >
        {t("多义边")}
      </Toggle>

      {/*
        截断必须说出来。热点函数有上百个调用方，画面上只画得下十几个，
        不标注的话这张图看起来就像「它只被这些地方调用」。
      */}
      {omitted > 0 && (
        <span
          className="text-[11px] text-[var(--color-warn)]"
          title={t("按调用次数取前若干条。完整列表在右侧详情的「关系」标签页")}
        >
          {t("另有 {count} 条未画", { count: omitted })}
        </span>
      )}
    </>
  );
}

function WalkControls() {
  const t = useT();
  const close = useAppStore((s) => s.closeWalk);
  const allCalls = useAppStore((s) => s.walkAllCalls);
  const setAllCalls = useAppStore((s) => s.setWalkAllCalls);
  const mainPath = useAppStore((s) => s.walkMainPath);
  const setMainPath = useAppStore((s) => s.setWalkMainPath);
  return (
    <>
      <Toggle
        active={mainPath}
        onClick={() => setMainPath(!mainPath)}
        title={t("跳过提前 return / throw 的守卫分支和 catch，先把正常流程读通")}
      >
        {t("主路径")}
      </Toggle>
      <Toggle
        active={allCalls}
        onClick={() => setAllCalls(!allCalls)}
        title={t("把外部库和静态分析解析不了的调用也列为步骤")}
      >
        {t("全部调用")}
      </Toggle>
      <button type="button" onClick={close}
        className="rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)]">
        {t("返回结构图")}
      </button>
    </>
  );
}

/** Breadcrumbs only appear when focused or expanded; in the default view, they are pure noise. */
function Breadcrumb() {
  const t = useT();
  const store = useAppStore();
  const focusLabel = useNodeScope(store.focus)?.label;
  const parts: Array<{ key: string; label: string; onClick: () => void }> = [];

  if (store.callGraph) {
    parts.push({
      key: "callgraph",
      label: t("调用图 {name}", { name: store.callGraph.label }),
      onClick: () => store.closeCallGraph(),
    });
  }
  if (store.walk) {
    parts.push({
      key: "walk",
      label: t("走读 {name}", { name: store.walk.label }),
      onClick: () => store.closeWalk(),
    });
  }
  if (store.focus !== null) {
    parts.push({
      key: "focus",
      label: t("聚焦 {name}", { name: focusLabel ?? labelOf(store.focus) }),
      onClick: () => store.setFocus(null),
    });
  }
  // The number of expanded layers belongs to the state of the structural view, and in call graph mode it is neither visible nor operable.
  // Displaying it will only make people think that the breadcrumb describes the picture in front of them.
  if (store.expanded.length > 0 && !store.callGraph) {
    parts.push({
      key: "expanded",
      label: t("已展开 {count} 层", { count: store.expanded.length }),
      onClick: () => useAppStore.setState({ expanded: [] }),
    });
  }
  if (store.hiddenNodes.length > 0) {
    parts.push({
      key: "hidden",
      label: t("已隐藏 {count} 项", { count: store.hiddenNodes.length }),
      onClick: () => store.resetHidden(),
    });
  }

  if (parts.length === 0) return null;

  return (
    <div data-breadcrumb className="anim-fade flex shrink-0 items-center gap-1.5">
      {parts.map((part) => (
        <button
          key={part.key}
          type="button"
          onClick={part.onClick}
          className="group flex max-w-64 items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface-2)] py-0.5 pl-2.5 pr-1.5 text-[11px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)]"
        >
          <span className="truncate">{part.label}</span>
          <span className="text-[var(--color-ink-faint)] group-hover:text-[var(--color-ink)]">×</span>
        </button>
      ))}
    </div>
  );
}

function EntriesPill() {
  const t = useT();
  const store = useAppStore();
  const open = store.treeOpen && store.panelTab === "entries";
  return (
    <button type="button" onClick={() => { store.setPanelTab("entries"); store.setTreeOpen(!open); }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
      style={{ borderColor: open ? "var(--color-accent)" : "var(--color-line)", color: open ? "var(--color-accent)" : "var(--color-ink-muted)" }}
      title={t("从 main、路由、CLI 命令等入口开始，单步走读代码怎么跑")} aria-label={t("入口")}>
      ⇢<span data-topbar-optional="2">{t("入口")}</span>
    </button>
  );
}

function ChangesPill() {
  const t = useT();
  const store = useAppStore();
  const open = store.treeOpen && store.panelTab === "changes";
  return (
    <button type="button" onClick={() => { store.setPanelTab("changes"); store.setTreeOpen(!open); }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
      style={{ borderColor: open ? "var(--color-accent)" : "var(--color-line)", color: open ? "var(--color-accent)" : "var(--color-ink-muted)" }}
      title={t("对比某个提交：这次改了哪些依赖、接口和入口")} aria-label={t("变更")}>
      Δ<span data-topbar-optional="2">{t("变更")}</span>
    </button>
  );
}

function labelOf(nodeId: string): string {
  const colon = nodeId.indexOf(":");
  const rest = colon >= 0 ? nodeId.slice(colon + 1) : nodeId;
  const slash = rest.lastIndexOf("/");
  return slash >= 0 ? rest.slice(slash + 1) : rest;
}

function Toggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-line)] text-[var(--color-ink-faint)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Health check-up entrance.
 *
 * Only appear when there is a real problem — when there is no problem, it should not take up space, and even less should it display a '0' to people
 * Repeated confirmation. This is the 'deletion' strategy: the mere presence of an interface element itself constitutes a demand for attention.
 */
function FindingsPill() {
  const t = useT();
  const [summary, setSummary] = useState<FindingSummaryDto | null>(null);
  const store = useAppStore();
  const repoId = store.repoId;
  const repoRevision = store.repoRevision;
  const indexRevision = store.indexRevision;

  // Re-fetch according to the warehouse. Otherwise, after switching the warehouse, the number of issues from the previous warehouse will still be displayed here.
  // The corner mark will be clicked as if it were a fact. After the index refreshes, it will be retrieved again, but it won’t be cleared first to avoid the corner mark flashing.
  const lastRepo = useRef<string>("");
  useEffect(() => {
    let stale = false;
    const key = `${repoId ?? ""}:${repoRevision}`;
    if (lastRepo.current !== key) setSummary(null);
    lastRepo.current = key;
    void api
      .findings()
      .then((res) => {
        if (!stale) setSummary(res.summary);
      })
      .catch(() => {
        if (!stale) setSummary(null);
      });
    return () => {
      stale = true;
    };
  }, [repoId, repoRevision, indexRevision]);

  if (!summary || summary.total === 0) return null;

  const open = store.treeOpen && store.panelTab === "findings";
  const color = summary.high > 0 ? "var(--color-danger)" : "var(--color-warn)";

  return (
    <button
      type="button"
      onClick={() => {
        store.setPanelTab("findings");
        store.setTreeOpen(!open);
      }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
      style={{
        borderColor: open ? color : "var(--color-line)",
        color: open ? color : "var(--color-ink-muted)",
      }}
      title={t("架构体检：{count} 处结构问题", { count: summary.total })}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span data-topbar-optional="2">{t("体检")}</span>
      {summary.total}
    </button>
  );
}
