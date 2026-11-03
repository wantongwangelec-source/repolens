import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { ChatToolStepDto } from "@repolens/core/types";
import { useShallow } from "zustand/react/shallow";
import { Chevron } from "../ui/Chevron";
import { t, translateMessage, useT } from "../i18n";
import { desktop } from "../lib/desktop";
import { readPref, writePref } from "../lib/prefs";
import { modKey } from "../lib/shortcut";
import { draftFor, hasNoteTarget, noteTextFromAnswer, SaveNotePopover, SelectionNote, type NoteDraft } from "../notes/SaveNote";
import { useAppStore } from "../store/useAppStore";
import {
  autoAttachments,
  useChatStore,
  type ChatAttachment,
  type ChatMessage,
} from "../store/useChatStore";

// Markdown parsing is only needed the first time it appears in the answer, not included in the first screen package.
const ChatMarkdown = lazy(() => import("../ui/ChatMarkdown").then((module) => ({ default: module.ChatMarkdown })));

const HEIGHT_STORAGE_KEY = "repolens:chat-height";
const DEFAULT_HEIGHT = 340;
const MIN_HEIGHT = 180;
/** When the conversation expands, leave at least this much height at the top for details, so it won't be squeezed into a single tab bar. */
const MIN_DETAIL_HEIGHT = 140;

/**
 * The follow-up AI panel is docked at the bottom of the right sidebar.
 *
 * Place it below the details instead of opening another floating window: the question is almost always about 'this thing I'm looking at'.
 * The context is right above your head, so your eyes don’t have to jump back and forth across the canvas; the canvas will also no longer be blocked by an extra piece.
 * When no item is selected, it occupies the sidebar alone.
 */
export function ChatDock({ detailVisible }: { detailVisible: boolean }) {
  useT();
  const chatOpen = useAppStore((s) => s.chatOpen);
  const openChat = useChatStore((s) => s.open);
  const messageCount = useChatStore((s) => s.messages.length);
  const split = useSplitHeight(detailVisible && chatOpen);

  if (!chatOpen) {
    return (
      <button
        type="button"
        onClick={() => openChat()}
        className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--color-line)] px-3 text-left text-[11.5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-muted)]"
      >
        <span className="text-[var(--color-accent)]">✦</span>
        <span className="truncate">
          {messageCount > 0 ? t("继续追问（{count} 轮对话）", { count: Math.ceil(messageCount / 2) }) : t("追问 AI…")}
        </span>
        <kbd className="mono ml-auto shrink-0 text-[10px]">{modKey("I")}</kbd>
      </button>
    );
  }

  return (
    <section
      ref={split.ref}
      className="relative flex min-h-0 flex-col border-t border-[var(--color-line)] bg-[var(--color-surface)]"
      style={detailVisible ? { height: split.height, flexShrink: 0 } : { flex: 1 }}
    >
      {detailVisible && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("调整对话区高度")}
          onPointerDown={split.onPointerDown}
          onDoubleClick={split.reset}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
        />
      )}
      <ChatHeader />
      <ChatThread />
      <ChatComposer />
    </section>
  );
}

function ChatHeader() {
  useT();
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const clear = useChatStore((s) => s.clear);
  const hasMessages = useChatStore((s) => s.messages.length > 0);
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-line)] pl-3 pr-1.5">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-accent)]">{t("追问 AI")}</span>
      <div className="ml-auto flex items-center gap-0.5">
        {hasMessages && (
          <button
            type="button"
            onClick={clear}
            className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink-muted)]"
          >
            {t("新对话")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setChatOpen(false)}
          title={t("收起（Esc）")}
          aria-label={t("收起对话")}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
        >
          <Chevron open />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat log
// ---------------------------------------------------------------------------

function ChatThread() {
  const messages = useChatStore((s) => s.messages);
  const ref = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const stick = useRef(true);

  // When the user scrolls up, do not pull them back to the bottom; follow new content when near the bottom
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={(element) => {
        ref.current = element;
        setContainer(element);
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
      className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
    >
      {messages.length === 0 ? (
        <EmptyThread />
      ) : (
        <div className="space-y-3">
          {messages.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage key={message.id} message={message} last={message === messages.at(-1)} />
            ),
          )}
        </div>
      )}
      <SelectionNote container={container} />
    </div>
  );
}

function EmptyThread() {
  useT();
  const selected = useAppStore((s) => s.selected);
  const callGraph = useAppStore((s) => s.callGraph !== null);
  const walking = useAppStore((s) => s.walk !== null);
  const send = useChatStore((s) => s.send);
  const reason = useAppStore((s) => (s.overview?.llm && !(s.overview.llm.enabled && s.overview.llm.available)
    ? (s.overview.llm.reason ? translateMessage(s.overview.llm.reason) : t("扫描时未启用 AI"))
    : null));

  const suggestions = walking
    ? [t("当前这一步在做什么？"), t("这里的实参是从哪里来的？"), t("这个函数走完之后会发生什么？")]
    : callGraph
      ? [t("这些调用方分别在什么场景下调用它？"), t("改动它的签名会影响哪些地方？")]
      : selected?.startsWith("sym:")
        ? [t("这个函数做了什么，为什么这样写？"), t("谁会调用它，在什么场景下？"), t("有哪些边界情况或潜在问题？")]
        : selected?.startsWith("file:")
          ? [t("这个文件的职责是什么？"), t("应该从哪个函数开始读？"), t("它和哪些模块耦合最紧？")]
          : selected
            ? [t("这个模块整体是怎么组织的？"), t("它对外暴露了哪些能力？"), t("从哪里开始读比较好？")]
            : [t("这个仓库的整体架构是怎样的？"), t("主要入口在哪里？"), t("新人应该按什么顺序读代码？")];

  return (
    <div className="py-1">
      <p className="text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        {t("AI 会读到下方标签里的上下文：选中节点的源码与关系、当前画布视图，以及你引用的片段。在详情里划选文字、或在伪代码步骤上点「追问」，都能把它加进来。")}
      </p>
      {reason && (
        <p className="mt-2 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/5 px-2 py-1.5 text-[10.5px] text-[var(--color-warn)]">
          {t("AI 可能不可用：{reason}", { reason })}
          {desktop && (
            <button
              type="button"
              onClick={() => useAppStore.getState().setSettingsOpen(true)}
              className="ml-1.5 underline underline-offset-2 hover:text-[var(--color-ink)]"
            >
              {t("去设置")}
            </button>
          )}
        </p>
      )}
      <div className="mt-2.5 flex flex-col items-start gap-1">
        {suggestions.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => void send(text)}
            className="rounded-md border border-[var(--color-line)] px-2 py-1 text-left text-[11px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-ink)]"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent-dim)] px-2.5 py-2">
      {message.attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {message.attachments.map((item) => (
            <AttachmentChip key={item.key} item={item} />
          ))}
        </div>
      )}
      <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-ink)]">{message.content}</div>
    </div>
  );
}

function AssistantMessage({ message, last }: { message: ChatMessage; last: boolean }) {
  useT();
  const retry = useChatStore((s) => s.retry);
  const [showContext, setShowContext] = useState(false);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const streaming = message.status === "streaming";
  const canNote = !streaming && message.content.trim() !== "" && hasNoteTarget(message.id);

  const lookingUp = message.tools.some((step) => step.status === "running");

  return (
    <div className="pl-0.5">
      {message.tools.length > 0 && <ToolSteps steps={message.tools} streaming={streaming} />}
      {message.content === "" && streaming ? (
        lookingUp ? null : (
          <div className="flex items-center gap-2 text-[11px] text-[var(--color-ink-faint)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
            {message.context ? t("正在思考…") : t("正在读取上下文…")}
          </div>
        )
      ) : (
        <div data-note-source={streaming ? undefined : message.id}>
          <Suspense
            fallback={<div className="whitespace-pre-wrap text-[12px] leading-relaxed">{message.content}</div>}
          >
            <ChatMarkdown content={message.content} streaming={streaming} />
          </Suspense>
        </div>
      )}
      {streaming && message.content !== "" && (
        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-[var(--color-accent)] align-middle" />
      )}

      {message.status === "error" && (
        <div className="mt-1.5 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/5 px-2 py-1.5 text-[11px] text-[var(--color-warn)]">
          {message.error}
          {last && (
            <button type="button" onClick={() => void retry()} className="ml-2 underline-offset-2 hover:underline">
              {t("重试")}
            </button>
          )}
        </div>
      )}

      {(message.context || message.status === "stopped" || canNote) && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-[var(--color-ink-faint)]">
          {message.status === "stopped" && (
            <>
              <span>{t("已停止")}</span>
              {last && (
                <button type="button" onClick={() => void retry()} className="hover:text-[var(--color-ink-muted)]">
                  {t("重新回答")}
                </button>
              )}
            </>
          )}
          {message.context && (
            <button
              type="button"
              aria-expanded={showContext}
              onClick={() => setShowContext((value) => !value)}
              className="transition-colors hover:text-[var(--color-ink-muted)]"
            >
              {t("依据 {count} 项上下文", { count: message.context.length })} {showContext ? "▾" : "▸"}
            </button>
          )}
          {canNote && (
            <button
              type="button"
              title={t("把整段回答存为笔记；只想存一部分可以先划选")}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setNoteDraft(draftFor(message.id, noteTextFromAnswer(message.content), {
                  left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom,
                }));
              }}
              className="ml-auto flex items-center gap-1 transition-colors hover:text-[var(--color-note)]"
            >
              <span aria-hidden="true">✎</span>{t("记笔记")}
            </button>
          )}
        </div>
      )}
      {noteDraft && <SaveNotePopover draft={noteDraft} onClose={() => setNoteDraft(null)} />}
      {showContext && message.context && (
        <ul className="mt-1 space-y-0.5 border-l border-[var(--color-line)] pl-2">
          {message.context.map((item, index) => (
            <li key={index} className="flex gap-2 text-[10.5px]">
              <span className="truncate text-[var(--color-ink-muted)]">{item.label}</span>
              <span className="truncate text-[var(--color-ink-faint)]">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The model answers by showing the steps it took to look it up itself. During the answering process, it unfolds so that people can see what it is reading;
 * After completing a row of entries, open it again only when you need to check the basis.
 */
function ToolSteps({ steps, streaming }: { steps: ChatToolStepDto[]; streaming: boolean }) {
  useT();
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? streaming;
  return (
    <div className="mb-1.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
      >
        {t("查阅 {count} 次", { count: steps.length })} {expanded ? "▾" : "▸"}
      </button>
      {expanded && (
        <ul className="mt-1 space-y-0.5 border-l border-[var(--color-line)] pl-2">
          {steps.map((step) => (
            <ToolStepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolStepRow({ step }: { step: ChatToolStepDto }) {
  const openDetail = useAppStore((s) => s.openDetail);
  const reveal = useAppStore((s) => s.reveal);
  const nodeId = step.nodeId ?? null;
  const target = `${step.target}${step.lines ? ` L${step.lines[0]}–${step.lines[1]}` : ""}`;
  const error = step.error ? translateMessage(step.error) : null;
  const targetClass = "mono min-w-0 truncate";

  let targetView = target === "" ? null : <span className={`${targetClass} text-[var(--color-ink-faint)]`}>{target}</span>;
  if (target !== "" && step.url) {
    targetView = (
      <a href={step.url} target="_blank" rel="noreferrer" title={step.url} className={`${targetClass} text-[var(--color-accent)] hover:underline`}>
        {target}
      </a>
    );
  } else if (target !== "" && nodeId) {
    targetView = (
      <button
        type="button"
        title={t("打开")}
        onClick={() => {
          // Directly look at the source code of the file and locate the lines that have been read; symbols and directories are located on the canvas.
          if (nodeId.startsWith("file:") || nodeId.startsWith("raw:")) {
            openDetail(nodeId, { tab: "source", lines: step.lines ?? null }, false);
          } else void reveal(nodeId);
        }}
        className={`${targetClass} text-left text-[var(--color-ink-muted)] underline-offset-2 hover:text-[var(--color-accent)] hover:underline`}
      >
        {target}
      </button>
    );
  }

  return (
    <li className="flex min-w-0 items-center gap-1.5 text-[10.5px]" title={error ?? undefined}>
      <span aria-hidden="true" className="flex w-2.5 shrink-0 justify-center">
        {step.status === "running" ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
        ) : step.status === "error" ? (
          <span className="text-[var(--color-warn)]">!</span>
        ) : (
          <span className="text-[var(--color-ink-faint)]">✓</span>
        )}
      </span>
      <span className="shrink-0 text-[var(--color-ink-muted)]">{toolLabel(step)}</span>
      {targetView}
      {error && <span className="min-w-0 shrink truncate text-[var(--color-warn)]">{error}</span>}
    </li>
  );
}

function toolLabel(step: ChatToolStepDto): string {
  switch (step.tool) {
    case "list_files": return t("列出目录");
    case "read_file": return t("读取");
    case "search_code": return t("搜索");
    case "find_symbols": return t("查找符号");
    case "get_node": return t("查看节点");
    case "git_log": return t("提交历史");
    case "git_show": return t("查看提交");
    case "git_blame": return t("逐行追溯");
    case "git_diff": return t("查看改动");
    case "fetch_url": return t("抓取网页");
  }
}

// ---------------------------------------------------------------------------
// Input box
// ---------------------------------------------------------------------------

function ChatComposer() {
  useT();
  const app = useAppStore(
    useShallow((s) => ({
      selected: s.selected,
      subgraphs: s.subgraphs,
      expanded: s.expanded,
      rootScope: s.rootScope,
      callGraph: s.callGraph,
      walk: s.walk,
    })),
  );
  const chat = useChatStore(
    useShallow((s) => ({
      attachments: s.attachments,
      dismissedAuto: s.dismissedAuto,
      includeView: s.includeView,
      labels: s.labels,
      streaming: s.streaming,
      draft: s.draft,
      focusNonce: s.focusNonce,
      send: s.send,
      stop: s.stop,
      detach: s.detach,
      dismissAuto: s.dismissAuto,
      setIncludeView: s.setIncludeView,
      setDraft: s.setDraft,
    })),
  );
  const textarea = useRef<HTMLTextAreaElement>(null);

  // After refreshing, restore the previously opened conversations according to memory without stealing focus; otherwise, the arrow keys used for reading will be captured by the input box as soon as you press them.
  useEffect(() => {
    if (chat.focusNonce > 0) textarea.current?.focus();
  }, [chat.focusNonce]);

  // The height increases with the content up to about six lines; beyond that, it will scroll within the box.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [chat.draft]);

  const auto = autoAttachments(chat, app);
  const autoKeys = new Set(auto.map((item) => item.key));
  const manual = chat.attachments.filter((item) => !autoKeys.has(item.key));
  const canSend = chat.draft.trim() !== "" && !chat.streaming;

  const submit = () => {
    if (canSend) void chat.send(chat.draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-[var(--color-line)] p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {auto.map((item) => (
          <AttachmentChip
            key={item.key}
            item={item}
            auto
            onRemove={() => (item.kind === "view" ? chat.setIncludeView(false) : item.kind === "node" && chat.dismissAuto(item.id))}
          />
        ))}
        {manual.map((item) => (
          <AttachmentChip key={item.key} item={item} onRemove={() => chat.detach(item.key)} />
        ))}
        {!chat.includeView && (
          <button
            type="button"
            onClick={() => chat.setIncludeView(true)}
            className="rounded border border-dashed border-[var(--color-line)] px-1.5 py-px text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
          >
            + {t("当前视图")}
          </button>
        )}
      </div>
      <div className="flex items-end gap-1.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2 py-1.5 focus-within:border-[var(--color-accent)]/50">
        <textarea
          ref={textarea}
          rows={1}
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("问点什么…（Enter 发送，Shift+Enter 换行）")}
          className="thin-scroll min-h-[20px] flex-1 resize-none bg-transparent text-[11px] leading-[20px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
        {chat.streaming ? (
          <button
            type="button"
            onClick={chat.stop}
            className="shrink-0 rounded border border-[var(--color-line-strong)] px-2 py-0.5 text-[11px] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
          >
            {t("停止")}
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSend}
            onClick={submit}
            className="shrink-0 rounded bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-canvas)] transition-opacity disabled:opacity-30"
          >
            {t("发送")}
          </button>
        )}
      </div>
    </div>
  );
}

const CHIP_MARKERS: Record<ChatAttachment["kind"], string> = { node: "◇", quote: "❝", view: "▦" };

function AttachmentChip({
  item,
  auto = false,
  onRemove,
}: {
  item: ChatAttachment;
  auto?: boolean;
  onRemove?: () => void;
}) {
  useT();
  const title = item.kind === "quote" ? item.text : item.kind === "node" ? item.id : undefined;
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px text-[10px] ${
        auto
          ? "border-[var(--color-line)] text-[var(--color-ink-faint)]"
          : "border-[var(--color-accent)]/40 text-[var(--color-accent)]"
      }`}
    >
      <span aria-hidden="true">{CHIP_MARKERS[item.kind]}</span>
      <span className="truncate">{item.label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("移除 {name}", { name: item.label })}
          className="-mr-0.5 px-0.5 opacity-60 transition-opacity hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Separation from the details section
// ---------------------------------------------------------------------------

function useSplitHeight(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(readHeight);

  const clamp = (value: number) => {
    const parent = ref.current?.parentElement?.clientHeight ?? window.innerHeight;
    return Math.round(Math.min(Math.max(value, MIN_HEIGHT), Math.max(MIN_HEIGHT, parent - MIN_DETAIL_HEIGHT)));
  };

  // When the window becomes shorter, compress the dialog area back within the allowed range to avoid squeezing out the details.
  useEffect(() => {
    if (!active) return;
    const onResize = () => setHeight((value) => clamp(value));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    let latest = startHeight;
    const onMove = (move: globalThis.PointerEvent) => {
      latest = clamp(startHeight + (startY - move.clientY));
      setHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      writeHeight(latest);
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const reset = () => {
    setHeight(clamp(DEFAULT_HEIGHT));
    writeHeight(DEFAULT_HEIGHT);
  };

  return { ref, height, onPointerDown, reset };
}

function readHeight(): number {
  const value = Number(readPref(HEIGHT_STORAGE_KEY));
  return Number.isFinite(value) && value >= MIN_HEIGHT ? value : DEFAULT_HEIGHT;
}

function writeHeight(value: number): void {
  writePref(HEIGHT_STORAGE_KEY, String(value));
}
