import { useEffect } from "react";
import { subscribeRepoEvents } from "./api/client";
import { GraphCanvas } from "./graph/GraphCanvas";
import { useLocale, useT } from "./i18n";
import { DetailDrawer } from "./layout/DetailDrawer";
import { TopBar } from "./layout/TopBar";
import { TreePanel } from "./layout/TreePanel";
import { desktop } from "./lib/desktop";
import { CommandPalette } from "./overlays/CommandPalette";
import { HelpSheet } from "./overlays/HelpSheet";
import { SettingsDialog } from "./overlays/SettingsDialog";
import { useAppStore } from "./store/useAppStore";
import { useChatStore } from "./store/useChatStore";
import { composeNote } from "./store/useNotesStore";
import { WalkView } from "./walk/WalkView";

function typingIn(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/** ⌘I: If the conversation is not open, open it and focus; if it is open but the focus is not in the input box, pull back the focus; if already in the input box, then collapse it. */
function toggleChat(): void {
  const { chatOpen, setChatOpen } = useAppStore.getState();
  const typing = document.activeElement instanceof HTMLTextAreaElement &&
    document.activeElement.closest("aside") !== null;
  if (chatOpen && typing) setChatOpen(false);
  else useChatStore.getState().open();
}

export function App() {
  const boot = useAppStore((s) => s.boot);
  const bootError = useAppStore((s) => s.bootError);
  const overview = useAppStore((s) => s.overview);
  const escape = useAppStore((s) => s.escape);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const walking = useAppStore((s) => s.walk !== null);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const noRepo = useAppStore((s) => s.noRepo);
  const locale = useLocale();

  useEffect(() => {
    void boot();
  }, [boot]);

  // Watching the status of file changes and 'index refresh completed' pushed from the server: while AI modifies the code on the side, the diagrams, health check, and change pages update themselves
  const repoId = useAppStore((s) => s.repoId);
  const ready = overview !== null;
  useEffect(() => {
    if (repoId === null || !ready) return;
    const { setWatchStatus, refreshIndex } = useAppStore.getState();
    return subscribeRepoEvents(repoId, {
      onStatus: setWatchStatus,
      onIndex: (refreshedAt) => void refreshIndex(refreshedAt),
    });
  }, [repoId, ready]);

  // The native menu and update dialog are drawn by the main process, so you need to inform it when the interface language changes.
  useEffect(() => {
    desktop?.setLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (!desktop) return;
    const offCommand = desktop.onCommand((command) => {
      const store = useAppStore.getState();
      if (command === "add-repository") store.requestAddRepo();
      if (command === "open-settings") store.setSettingsOpen(true);
      if (command === "refresh-status") void store.refreshOverview().catch(() => {});
    });
    const offFullScreen = desktop.onFullScreenChange((fullScreen) => {
      document.documentElement.toggleAttribute("data-fullscreen", fullScreen);
    });
    return () => {
      offCommand();
      offFullScreen();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The Esc key when composing characters with an input method is to cancel the candidate word, not to exit.
      if (event.isComposing) return;
      if (event.key === "Escape") {
        escape();
        return;
      }
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key.toLowerCase() === "i" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleChat();
      }
      // N: Jot down a note. When the focus is in the input box, N is just N
      if (event.key === "n" && !event.metaKey && !event.ctrlKey && !event.altKey && !typingIn(event.target)) {
        event.preventDefault();
        composeNote();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escape, setPaletteOpen]);

  // The top bar should be kept even when an error occurs. After switching to a repository whose index has become invalid, the only way out is
  // The warehouse selector in the top bar; if you change it to an error page together, people can only restart the process.
  return (
    <div className="flex h-full flex-col">
      <TopBar />

      <main className="relative flex-1 overflow-hidden">
        {bootError !== null ? (
          <BootFailure message={bootError} />
        ) : noRepo ? (
          <Welcome />
        ) : overview === null ? (
          <BootSkeleton />
        ) : (
          walking ? (
            <WalkView key={`walk:${repoRevision}`} />
          ) : (
            <GraphCanvas key={`graph:${repoRevision}`} />
          )
        )}
        <TreePanel />
        <DetailDrawer />
      </main>

      <CommandPalette />
      <HelpSheet />
      {desktop && <SettingsDialog />}
    </div>
  );
}

function Welcome() {
  const t = useT();
  const requestAddRepo = useAppStore((s) => s.requestAddRepo);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="text-[15px] font-medium">{t("打开一个代码仓库")}</div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
          {t("选择本机的代码目录，RepoLens 会在本地建立索引，之后就能浏览架构分层、调用关系，并从入口单步走读代码。")}
          {t("启用 AI 后，生成摘要和回答追问时会把相关代码发给你配置的模型服务。")}
        </p>
        <button
          type="button"
          onClick={requestAddRepo}
          className="mt-5 rounded-md bg-[var(--color-accent)] px-4 py-2 text-[12px] font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90"
        >
          {t("添加本地仓库")}
        </button>
        {!desktop && (
          <p className="mono mt-4 text-[11px] text-[var(--color-ink-faint)]">
            {t("也可以在终端运行 repolens scan <仓库路径>")}
          </p>
        )}
      </div>
    </div>
  );
}

function BootFailure({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="text-[14px] font-medium">{t("无法加载索引")}</div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">{message}</p>
        <p className="mono mt-3 text-[11px] text-[var(--color-ink-faint)]">
          {desktop ? t("在顶栏的仓库菜单里重新扫描，或添加其他仓库") : t("先运行 repolens scan <仓库路径>")}
        </p>
      </div>
    </div>
  );
}

function BootSkeleton() {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-[12px] text-[var(--color-ink-faint)]">{t("正在读取索引…")}</div>
    </div>
  );
}
