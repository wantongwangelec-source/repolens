import type { ChatContextItemDto, ChatMessageDto, ChatRefDto, ChatToolStepDto } from "@repolens/core/types";
import { create } from "zustand";
import { api } from "../api/client";
import { t } from "../i18n";
import { useAppStore, type AppState } from "./useAppStore";

/** Node ID accepted by the server; synthetic nodes such as aggregate nodes and external dependencies do not have readable content */
const CHAT_NODE_ID = /^(?:(?:sym|file):\d+|(?:dir|pkg):.+)$/;

export type ChatAttachment =
  | { key: string; kind: "node"; id: string; label: string }
  | {
      key: string;
      kind: "quote";
      text: string;
      nodeId: string | null;
      lines: [number, number] | null;
      label: string;
    }
  | { key: string; kind: "view"; ref: Extract<ChatRefDto, { kind: "view" }>; label: string };

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** The context attached when the user message is sent, used to echo as a chip */
  attachments: ChatAttachment[];
  /** The context that the server actually puts into the prompt only includes the assistant's messages. */
  context: ChatContextItemDto[] | null;
  /** The steps that the model reviews by itself during the answering process, arranged in the order they started */
  tools: ChatToolStepDto[];
  status: "streaming" | "done" | "error" | "stopped";
  error: string | null;
}

interface ChatState {
  messages: ChatMessage[];
  /** Attachments manually added by the user but not yet sent */
  attachments: ChatAttachment[];
  /**
   * The currently selected item will automatically be used as an attachment. After the user removes it, it will not be automatically added back to the same node.
   * It will naturally restore when the selected item is changed.
   */
  dismissedAuto: string | null;
  includeView: boolean;
  streaming: boolean;
  draft: string;
  /** Increment means the input box gains focus */
  focusNonce: number;
  /** After the details are loaded, note down the node names, and give the nodes that are not on the canvas a decent chip name. */
  labels: Record<string, string>;

  open: (focus?: boolean) => void;
  rememberLabel: (id: string, label: string) => void;
  attach: (attachment: ChatAttachment) => void;
  detach: (key: string) => void;
  dismissAuto: (nodeId: string) => void;
  setIncludeView: (value: boolean) => void;
  setDraft: (value: string) => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
  retry: () => Promise<void>;
  clear: () => void;
}

let controller: AbortController | null = null;
let nextId = 1;

export const useChatStore = create<ChatState>((set, get) => {
  const patch = (id: number, update: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...(typeof update === "function" ? update(message) : update) } : message,
      ),
    }));

  const run = async (assistantId: number) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    set({ streaming: true });

    const history: ChatMessageDto[] = get()
      .messages.filter((message) => message.id < assistantId)
      // Failure or being aborted, responses with not a single word will not be replayed to the model
      .filter((message) => message.role === "user" || message.content.trim() !== "")
      .map((message) => ({
        role: message.role,
        content: message.content,
        refs: message.role === "user" ? message.attachments.map(toRef) : null,
      }));

    try {
      await api.chat(
        { messages: history },
        {
          onContext: (items) => patch(assistantId, { context: items }),
          onDelta: (text) => patch(assistantId, (message) => ({ content: message.content + text })),
          onTool: (step) => patch(assistantId, (message) => ({
            tools: message.tools.some((item) => item.id === step.id)
              ? message.tools.map((item) => (item.id === step.id ? step : item))
              : [...message.tools, step],
          })),
        },
        current.signal,
      );
      patch(assistantId, { status: "done" });
    } catch (err) {
      if (current.signal.aborted) patch(assistantId, { status: "stopped" });
      else patch(assistantId, { status: "error", error: (err as Error).message });
    } finally {
      if (controller === current) {
        controller = null;
        set({ streaming: false });
      }
    }
  };

  return {
    messages: [],
    attachments: [],
    dismissedAuto: null,
    includeView: true,
    streaming: false,
    draft: "",
    focusNonce: 0,
    labels: {},

    open(focus = true) {
      useAppStore.getState().setChatOpen(true);
      if (focus) set((state) => ({ focusNonce: state.focusNonce + 1 }));
    },

    rememberLabel(id, label) {
      if (get().labels[id] === label) return;
      set((state) => ({ labels: { ...state.labels, [id]: label } }));
    },

    attach(attachment) {
      set((state) => ({
        attachments: state.attachments.some((item) => item.key === attachment.key)
          ? state.attachments
          : [...state.attachments, attachment],
      }));
      get().open();
    },

    detach(key) {
      set((state) => ({ attachments: state.attachments.filter((item) => item.key !== key) }));
    },

    dismissAuto(nodeId) {
      set({ dismissedAuto: nodeId });
    },

    setIncludeView(value) {
      set({ includeView: value });
    },

    setDraft(value) {
      set({ draft: value });
    },

    async send(text) {
      const content = text.trim();
      if (content === "" || get().streaming) return;
      const attachments = pendingAttachments(get(), useAppStore.getState());
      const user: ChatMessage = {
        id: nextId++, role: "user", content, attachments, context: null, tools: [], status: "done", error: null,
      };
      const assistant: ChatMessage = {
        id: nextId++, role: "assistant", content: "", attachments: [], context: null, tools: [], status: "streaming", error: null,
      };
      set((state) => ({ messages: [...state.messages, user, assistant], attachments: [], draft: "" }));
      await run(assistant.id);
    },

    stop() {
      controller?.abort();
    },

    async retry() {
      const last = get().messages.at(-1);
      if (!last || last.role !== "assistant" || get().streaming) return;
      patch(last.id, { content: "", context: null, tools: [], status: "streaming", error: null });
      await run(last.id);
    },

    clear() {
      controller?.abort();
      controller = null;
      set({ messages: [], attachments: [], streaming: false, dismissedAuto: null });
    },
  };
});

// The node ID in the conversation belongs to a certain repository and a certain scan; it becomes invalid after changing the repository or rescanning.
useAppStore.subscribe((state, previous) => {
  if (state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision) {
    useChatStore.getState().clear();
    useChatStore.setState({ labels: {} });
  }
});

/** Decide the part of the canvas state that automatically attaches */
export type ChatViewState = Pick<
  AppState,
  "selected" | "subgraphs" | "expanded" | "rootScope" | "callGraph" | "walk"
>;

/** The context actually attached when sending: automatic attachments come first, manual attachments come later, deduplicated by key. */
export function pendingAttachments(chat: ChatState, app: ChatViewState): ChatAttachment[] {
  const auto = autoAttachments(chat, app);
  const seen = new Set<string>();
  return [...auto, ...chat.attachments].filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

export function autoAttachments(
  chat: Pick<ChatState, "dismissedAuto" | "includeView" | "labels">,
  app: ChatViewState,
): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  const selected = app.selected;
  if (selected && selected !== chat.dismissedAuto && CHAT_NODE_ID.test(selected)) {
    out.push(nodeAttachment(selected, nodeLabel(app, selected, chat.labels)));
  }
  if (chat.includeView) out.push(viewAttachment(app));
  return out;
}

export function nodeAttachment(id: string, label: string): ChatAttachment {
  return { key: `node:${id}`, kind: "node", id, label };
}

export function canAttachNode(id: string): boolean {
  return CHAT_NODE_ID.test(id);
}

function viewAttachment(app: ChatViewState): ChatAttachment {
  if (app.walk) {
    const top = app.walk.stack.at(-1);
    return {
      key: "view",
      kind: "view",
      ref: { kind: "view", mode: "walk", walk: app.walk.stack.map(({ id, at }) => ({ id, at })) },
      label: t("走读 · {name}", { name: top?.name ?? app.walk.label }),
    };
  }
  if (app.callGraph) {
    return {
      key: "view",
      kind: "view",
      ref: { kind: "view", mode: "callgraph", scope: app.callGraph.scopeId },
      label: t("调用图 · {name}", { name: app.callGraph.label }),
    };
  }
  // The most recently unfolded levels best indicate where the user is looking, and the server only takes the first few.
  const expanded = [...app.expanded].reverse().filter((id) => CHAT_NODE_ID.test(id));
  return {
    key: "view",
    kind: "view",
    ref: { kind: "view", mode: "structure", scope: app.rootScope, expanded },
    label: expanded.length > 0 ? t("结构图 · 展开 {count} 层", { count: expanded.length }) : t("结构图 · 仓库根"),
  };
}

/** Prefer to use the full name from the details first, then the node name on the canvas, and if neither exists, fallback to the last segment of the ID. */
export function nodeLabel(
  app: Pick<AppState, "subgraphs">,
  id: string,
  labels: Record<string, string> = {},
): string {
  const remembered = labels[id];
  if (remembered) return remembered;
  for (const graph of Object.values(app.subgraphs)) {
    const node = graph.nodes.find((item) => item.id === id);
    if (node) return node.label;
  }
  if (id.startsWith("dir:") || id.startsWith("pkg:")) return id.slice(4).split("/").at(-1) || id;
  return id.startsWith("sym:") ? t("符号") : t("文件");
}

function toRef(attachment: ChatAttachment): ChatRefDto {
  if (attachment.kind === "node") return { kind: "node", id: attachment.id };
  if (attachment.kind === "view") return attachment.ref;
  return { kind: "quote", text: attachment.text, nodeId: attachment.nodeId, lines: attachment.lines };
}
