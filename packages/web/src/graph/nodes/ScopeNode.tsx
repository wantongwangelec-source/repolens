import type { GraphNodeDto } from "@repolens/core/types";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { memo } from "react";
import { useT } from "../../i18n";
import { useAppStore, type MetricKey } from "../../store/useAppStore";
import { changeMarkOf, useChangesStore } from "../../store/useChangesStore";
import { formatCount, metricValue, nodeAccent, symbolGlyph } from "../../ui/visual";
import { CONTAINER_HEADER } from "../layout/useElkLayout";
import { LensBar } from "./LensBar";

export interface ScopeNodeData extends Record<string, unknown> {
  dto: GraphNodeDto;
  /** The denoised display name may be shorter than dto.label; the full name is reserved for the hover card and drawer. */
  label: string;
  metric: MetricKey;
  isContainer: boolean;
  selected: boolean;
  /** hover-highlighted protagonist */
  active: boolean;
  /** When hovering, stay adjacent to the main character and remain readable */
  related: boolean;
  /** Irrelevant on hover, decays to 15% */
  dimmed: boolean;
  /** Scaled too small, switch to low-detail rendering */
  lowDetail: boolean;
  /** Horizontal layout (call graph), with connection points attached to the sides instead of top and bottom */
  horizontal: boolean;
  truncatedInside: number;
}

export type ScopeNodeType = Node<ScopeNodeData, "scope">;

/**
 * The general node in the diagram.
 *
 * A component overrides four types: package/directory/file/symbol, because they only differ visually
 * A type tag and a main indicator—splitting into four components will only cause hovering/selection everywhere
 * There are slight differences in the state implementation.
 */
export const ScopeNode = memo(function ScopeNode({ data }: NodeProps<ScopeNodeType>) {
  const t = useT();
  const {
    dto,
    label,
    metric,
    isContainer,
    selected,
    active,
    related,
    dimmed,
    lowDetail,
    horizontal,
    truncatedInside,
  } = data;
  const accent = nodeAccent(dto);
  const value = metricValue(dto, metric);
  // Connection points should align with the layout direction; otherwise, edges arranged horizontally will first loop to the top of the node and then circle back.
  const inPos = horizontal ? Position.Left : Position.Top;
  const outPos = horizontal ? Position.Right : Position.Bottom;

  // The attenuation is meant to make that highlighted chain stand out, not to erase the rest.
  // If it gets pressed down to the point of being invisible, the user loses the context of 'where this link sits within the whole.'
  const opacity = dimmed ? 0.32 : 1;

  if (isContainer) {
    return (
      <div
        className="h-full w-full rounded-xl border transition-[opacity,box-shadow] duration-150"
        style={{
          opacity,
          borderColor: selected ? accent : "var(--color-line)",
          background: "color-mix(in srgb, var(--color-surface) 70%, transparent)",
          boxShadow: selected ? `0 0 0 1px ${accent}` : "none",
        }}
      >
        <Handle type="target" position={inPos} />
        <div
          className="flex items-center gap-2 px-3"
          style={{ height: CONTAINER_HEADER }}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
          <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
            {label}
          </span>
          <ChangeBadge dto={dto} />
          <FindingsBadge dto={dto} inline />
          <span className="ml-auto shrink-0 text-[11px] text-[var(--color-ink-faint)]">
            {formatCount(value)}
          </span>
        </div>
        {truncatedInside > 0 && (
          <div className="absolute bottom-1.5 right-2.5 text-[10px] text-[var(--color-ink-faint)]">
            {t("另有 {count} 项未展开", { count: truncatedInside })}
          </div>
        )}
        <LensBar dto={dto} container />
        <Handle type="source" position={outPos} />
      </div>
    );
  }

  const stackDepth = stackLayers(dto);

  return (
    <div
      className="relative h-full w-full"
      style={{
        opacity,
        // React Flow calculates Handles and connection endpoints based on the undeformed boundaries of nodes. This cannot be done here.
        // scale the entire node, otherwise the visual up/down/left/right handle will move, along with the SVG edge
        // Still stays at the old coordinates, and when hovering it feels like the connecting line has drifted or broken.
        transition: "opacity 140ms ease",
        zIndex: active ? 10 : undefined,
      }}
    >
      <Handle type="target" position={inPos} />

      {/*
        层叠卡片：可展开但尚未展开的节点渲染成微微错位的几层，
        同时传达「这里有东西」「有多少」「可以展开」三件事。
        见 docs/INTERACTION.md「折叠与堆叠」。
      */}
      {stackDepth > 0 &&
        Array.from({ length: stackDepth }, (_, i) => i + 1).map((layer) => (
          <div
            key={layer}
            className="absolute inset-0 rounded-[10px] border"
            style={{
              // The outer node has already enlarged as a whole when hovered; further spreading between layers would accumulate to a very large size.
              // Gap. Keep a tight offset, allowing the entire set of cards to scale up as a whole.
              transform: `translate(${layer * 3}px, ${layer * 3}px)`,
              borderColor: "var(--color-line)",
              background: "var(--color-surface)",
              opacity: 0.55 - layer * 0.12,
              zIndex: -layer,
            }}
          />
        ))}

      {/*
        调用图的中心节点画一圈外环。展开两跳之后画面上全是同构的函数卡片，
        没有这个锚点就找不到自己是从哪个函数出发的。
      */}
      <div
        className="relative flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-[10px] border px-3"
        style={{
          borderColor: dto.focus
            ? accent
            : selected
              ? accent
              : related
                ? "var(--color-line-strong)"
                : "var(--color-line)",
          background:
            selected || dto.focus
              ? `color-mix(in srgb, ${accent} 12%, var(--color-surface))`
              : "var(--color-surface)",
          boxShadow: dto.focus
            ? `0 0 0 1px ${accent}, 0 0 0 5px color-mix(in srgb, ${accent} 22%, transparent)`
            : selected
              ? `0 0 0 1px ${accent}`
              : active
                ? "var(--node-hover-shadow)"
                : "none",
        }}
      >
        <span
          className="absolute left-0 top-0 h-full w-[3px]"
          style={{ background: accent, opacity: dto.kind === "external" ? 0.4 : 0.85 }}
        />

        <FindingsBadge dto={dto} />

        {lowDetail ? (
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold" style={{ color: accent }}>
              {label.slice(0, 2)}
            </span>
            <ChangeBadge dto={dto} />
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-1.5">
              {dto.kind === "symbol" && (
                <span className="mono shrink-0 text-[11px]" style={{ color: accent }}>
                  {symbolGlyph(dto.symbolKind)}
                </span>
              )}
              <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                {label}
              </span>
              <ChangeBadge dto={dto} />
            </div>
            <div className="flex min-w-0 flex-nowrap items-center gap-2 whitespace-nowrap text-[10.5px] text-[var(--color-ink-faint)]">
              <span className="shrink-0">{formatCount(value)}</span>
              {dto.layer && <span className="shrink-0 text-[var(--color-accent)]">· {dto.layer}</span>}
              {dto.childCount > 0 && dto.kind !== "symbol" && (
                <span className="shrink-0 text-[var(--color-ink-faint)]">{t("· {count} 项", { count: dto.childCount })}</span>
              )}
              {dto.metrics.inDegree + dto.metrics.outDegree > 0 && (
                <span
                  className="ml-auto shrink-0 tabular-nums"
                  title={dto.kind === "symbol" ? t("调用 / 被调用") : t("依赖 / 被依赖")}
                >
                  {horizontal
                    ? `→${dto.metrics.outDegree} ←${dto.metrics.inDegree}`
                    : `↓${dto.metrics.outDegree} ↑${dto.metrics.inDegree}`}
                </span>
              )}
            </div>
          </>
        )}
        <LensBar dto={dto} />
      </div>

      <Handle type="source" position={outPos} />
    </div>
  );
});

/** The number of nested layers is categorized based on the number of sub-items, up to three layers—any more would just be visual noise. */
function stackLayers(dto: GraphNodeDto): number {
  if (!dto.expandable) return 0;
  if (dto.childCount >= 12) return 3;
  if (dto.childCount >= 4) return 2;
  if (dto.childCount >= 1) return 1;
  return 0;
}

/**
 * Change Badge: Only appears after performing a comparison once on the 'Change' tab. File and symbol tags added/modified,
 * Several files under the directory and package label have been modified—the changes can be seen at the top level to identify which parts they fall into.
 */
function ChangeBadge({ dto }: { dto: GraphNodeDto }) {
  const t = useT();
  const showNoise = useAppStore((s) => s.showNoise);
  const change = useChangesStore((s) => {
    const found = changeMarkOf(s.index, dto, showNoise);
    return found ? `${found.mark}:${found.count}` : null;
  });
  if (change === null) return null;
  const [mark, raw] = change.split(":") as ["added" | "modified", string];
  const count = Number(raw);
  const color = mark === "added" ? "var(--color-success)" : "var(--color-accent)";
  const container = dto.kind === "directory" || dto.kind === "package";

  return (
    <span
      className="shrink-0 rounded-full px-1 text-[9.5px] font-medium tabular-nums"
      style={{ background: `color-mix(in srgb, ${color} 20%, transparent)`, color }}
      title={container
        ? t("{count} 个文件有改动", { count })
        : mark === "added" ? t("对比基线新增") : t("对比基线有修改")}
    >
      {container ? `Δ${count}` : mark === "added" ? t("新") : t("改")}
    </span>
  );
}

/**
 * Medical examination watermark.
 *
 * Deliberately drawing only one dot and adding a number: its purpose is 'this spot is worth a look,' what exactly is the issue
 * Go to the left-side physical examination checklist or details to read. Placing text on the node will turn the chart into a report, while the value of the chart lies precisely in
 * It lies in the shape that can be seen at a glance.
 *
 * Counting includes descendant upper volumes, so in the package-level view, you can see which package the problem is concentrated in.
 */
function FindingsBadge({ dto, inline }: { dto: GraphNodeDto; inline?: boolean }) {
  const t = useT();
  const findings = dto.findings;
  if (!findings || findings.count === 0) return null;

  const color = findings.high > 0 ? "var(--color-danger)" : "var(--color-warn)";
  const position = inline ? "shrink-0" : "absolute right-1.5 top-1.5";

  return (
    <span
      className={`${position} flex items-center gap-0.5 rounded-full px-1 text-[9.5px] font-medium tabular-nums`}
      style={{ background: `color-mix(in srgb, ${color} 20%, transparent)`, color }}
      title={findings.high > 0
        ? t("{count} 处结构问题（{high} 处需优先看）", { count: findings.count, high: findings.high })
        : t("{count} 处结构问题", { count: findings.count })}
    >
      <span className="h-1 w-1 rounded-full" style={{ background: color }} />
      {findings.count}
    </span>
  );
}
