import type { GraphNodeDto } from "@repolens/core/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { ALT_KEY } from "../lib/shortcut";
import { useAppStore } from "../store/useAppStore";
import { canAttachNode, nodeAttachment, useChatStore } from "../store/useChatStore";

export interface ContextMenuState {
  node: GraphNodeDto;
  x: number;
  y: number;
}

interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * Right-click menu.
 *
 * The advanced operations explicitly meant to be placed here in the 'Hidden' strategy—they all have value, but none are
 * Frequent operations, placing them on the interface will only dilute the main path.
 */
export function NodeContextMenu({ state, onClose }: { state: ContextMenuState; onClose: () => void }) {
  const t = useT();
  const store = useAppStore();
  const ref = useRef<HTMLDivElement>(null);
  const { node } = state;
  const [position, setPosition] = useState({ left: state.x, top: state.y });

  // The menu width changes with the language and font size, and when it pops up near the window edge, it is retracted according to the actual size.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(8, Math.min(state.x, window.innerWidth - box.width - 14)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - box.height - 8)),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const isFocused = store.focus === node.id;
  const isExpanded = store.expanded.includes(node.id);

  const items: MenuItem[] = [
    {
      label: isExpanded ? t("收起子项") : t("展开子项"),
      hint: t("双击"),
      disabled: !node.expandable,
      run: () => void store.toggleExpand(node),
    },
    {
      label: isFocused ? t("退出聚焦") : t("以此为中心聚焦"),
      hint: t("{alt}双击", { alt: ALT_KEY }),
      run: () => store.setFocus(isFocused ? null : node.id),
    },
    {
      label: t("聚焦范围 +1 层"),
      disabled: !isFocused,
      run: () => store.setFocus(node.id, Math.min(4, store.focusDepth + 1)),
    },
    {
      label: t("隐藏此枝"),
      run: () => {
        store.hideBranch(node.id);
        onClose();
      },
    },
    {
      label: t("查看详情"),
      hint: t("单击"),
      run: () => store.select(node.id),
    },
    ...(node.symbolKind === "function" || node.symbolKind === "method"
      ? [{ label: t("从这里单步走读"), run: () => store.openWalk(node.id, node.label) }]
      : []),
    {
      label: t("加入 AI 对话"),
      disabled: !canAttachNode(node.id),
      run: () => useChatStore.getState().attach(nodeAttachment(node.id, node.label)),
    },
    {
      label: t("复制路径"),
      disabled: !node.path,
      run: () => {
        if (node.path) void navigator.clipboard.writeText(node.path);
      },
    },
  ];

  return (
    <div
      ref={ref}
      className="anim-fade fixed z-50 w-max min-w-[196px] max-w-[320px] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] py-1 shadow-2xl"
      style={position}
    >
      <div className="mono truncate border-b border-[var(--color-line)] px-3 pb-1.5 pt-0.5 text-[10px] text-[var(--color-ink-faint)]">
        {node.label}
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            item.run();
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:text-[var(--color-ink-faint)] disabled:hover:bg-transparent"
        >
          <span className="truncate">{item.label}</span>
          {item.hint && (
            <span className="ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
              {item.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
