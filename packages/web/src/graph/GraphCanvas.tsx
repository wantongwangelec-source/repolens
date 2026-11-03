import type { GraphNodeDto } from "@repolens/core/types";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
  type Edge,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../i18n";
import { edgeSelection, isContractEnd } from "../lib/edge";
import { HoverCard } from "./HoverCard";
import { LensLegend } from "./LensLegend";
import { NodeContextMenu, type ContextMenuState } from "./NodeContextMenu";
import { useAppStore, useGraphSlice, type MetricKey } from "../store/useAppStore";
import { useLensStore } from "../store/useLensStore";
import { displayLabels, metricValue, nodeAccent } from "../ui/visual";
import { applyFocus, flattenGraph, incidentEdgeIds, neighborIds } from "./model";
import { nodeSize } from "../ui/visual";
import { ScopeNode, type ScopeNodeType } from "./nodes/ScopeNode";
import { useElkLayout, type PositionedNode } from "./layout/useElkLayout";

const NODE_TYPES = { scope: ScopeNode };
const EDGE_DOT_MARKER = "repolens-edge-dot";
const ACTIVE_EDGE_DOT_MARKER = "repolens-active-edge-dot";

/** When scaling below this value, switch to lower detail rendering to avoid small text becoming a blur. */
const LOW_DETAIL_ZOOM = 0.45;

/** The margin ratio reserved when adapting to the viewport, calculated once for each side */
const FIT_PADDING = 0.09;
/**
 * Do not enlarge more than 1x when adapting. The font size, corner radius, and spacing of the nodes are all designed at 1x.
 * If you enlarge a small image to 2 times, you will get a bunch of blurry giant cards.
 */
const FIT_MAX_ZOOM = 1;
/**
 * When automatically adapting, it will not shrink smaller than this.
 *
 * When it can't fit, showing the user a clear portion is more useful than seeing a whole piece of noise—below this
 * The text on the zoomed node is no longer readable, so 'seeing the whole picture' is meaningless.
 */
const FIT_MIN_ZOOM = 0.5;
const FIT_DURATION = 320;
/**
 * The first screen doesn't have a 'previous shot' to transition from: from the React Flow default viewport (origin, 1x)
 * The animation comes over, it looks like the whole image is being thrown into the screen from the top left corner. So the first screen goes directly from the target
 * Fade in and settle at a slightly zoomed-out position of the viewport.
 */
const SETTLE_DURATION = 420;
const SETTLE_FROM_SCALE = 0.95;
/** Two clicks within this interval are considered a double-click, roughly consistent with the system default value. */
const DOUBLE_CLICK_MS = 320;

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

function CanvasInner() {
  const t = useT();
  const locale = useLocale();
  const slice = useGraphSlice();
  const focus = useAppStore((s) => s.focus);
  const focusDepth = useAppStore((s) => s.focusDepth);
  const metric = useAppStore((s) => s.metric);
  const hovered = useAppStore((s) => s.hovered);
  const selected = useAppStore((s) => s.selected);
  const loading = useAppStore((s) => s.loadingScopes.length > 0);
  // The action definitions in Zustand do not change once defined, and taking them out separately allows the following
  // useCallback truly stabilizes
  const hover = useAppStore((s) => s.hover);
  const select = useAppStore((s) => s.select);
  const toggleExpand = useAppStore((s) => s.toggleExpand);
  const setFocus = useAppStore((s) => s.setFocus);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const openCallGraph = useAppStore((s) => s.openCallGraph);
  const callGraph = useAppStore((s) => s.callGraph);
  const revealed = useAppStore((s) => s.revealed);
  const clearRevealed = useAppStore((s) => s.clearRevealed);

  const zoom = useFlowStore((s) => s.transform[2]);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const flat = useMemo(
    () => applyFocus(flattenGraph(slice), focus, focusDepth),
    [slice, focus, focusDepth],
  );

  const maxMetric = useMemo(
    () => Math.max(1, ...flat.nodes.map((n) => metricValue(n.dto, metric))),
    [flat.nodes, metric],
  );

  // The node width is estimated based on the metadata text. After switching languages, the text may become longer or shorter, requiring a layout adjustment.
  const sizeOf = useCallback(
    (node: { dto: GraphNodeDto }) => nodeSize(node.dto, metric, maxMetric),
    [metric, maxMetric, locale],
  );

  const horizontal = callGraph !== null;
  const layout = useElkLayout(flat, sizeOf, horizontal ? "RIGHT" : "DOWN");

  const lowDetail = zoom < LOW_DETAIL_ZOOM;

  const highlight = useMemo(() => {
    if (hovered === null) return null;
    // When zoomed out too far, the highlights can't be read in the first place, and attenuation will just turn the whole image into a black mess.
    if (lowDetail) return null;
    return {
      neighbors: neighborIds(flat.edges, hovered),
      edges: incidentEdgeIds(flat.edges, hovered),
    };
  }, [hovered, flat.edges, lowDetail]);

  // The viewport follows the attention. In the structure diagram, attention is on the newly expanded node; in the call diagram, it is on the set of nodes.
  // It will be replaced as a whole according to the number of jumps, and the anchor can only be that unchanging central symbol—otherwise, when adjusted to 2 jumps
  // The dozens of nodes spread out like a fan will pull the camera away, causing the starting point to end up outside the screen.
  // The priority of reveal: it is what the user has just explicitly clicked on, rather than the 'most recently expanded scope'.
  // Closer to where the attention is. The last layer of the unfolded chain is often the parent scope of the target, if you only enclose it
  // The target itself may fall on the edge of the container, or even off the screen.
  const attention = revealed ?? (callGraph ? `sym:${callGraph.symbolId}` : (slice.expanded.at(-1) ?? null));
  const framed = useAutoViewport(layout.nodes, layout.version, attention);

  // Consume it, otherwise it will be pulled back to this node every time the layout is done afterwards.
  useEffect(() => {
    if (revealed !== null) clearRevealed();
  }, [revealed, clearRevealed]);

  const labels = useMemo(() => displayLabels(flat.nodes.map((n) => n.dto)), [flat.nodes]);

  // Perspective overlay layer: only take the number of these nodes in front
  const lens = useAppStore((s) => s.lens);
  const lensRevision = useLensStore((s) => s.revision);
  const lensIds = useMemo(
    () => flat.nodes.map((n) => n.dto.id).filter((id) => /^(?:pkg|dir|file|sym):./.test(id)),
    [flat.nodes],
  );
  useEffect(() => {
    if (lens !== null) void useLensStore.getState().ensure(lens, lensIds);
  }, [lens, lensIds, lensRevision]);

  const nodes = useMemo<ScopeNodeType[]>(
    () =>
      layout.nodes.map((node) =>
        toFlowNode(node, {
          metric,
          selected,
          hovered,
          highlight,
          lowDetail,
          labels,
          horizontal,
          truncatedByScope: flat.truncatedByScope,
        }),
      ),
    [
      layout.nodes,
      metric,
      selected,
      hovered,
      highlight,
      lowDetail,
      labels,
      horizontal,
      flat.truncatedByScope,
    ],
  );

  const edges = useMemo<Edge[]>(
    () =>
      flat.edges.map((edge) => {
        const picked = selected !== null && selected === edgeSelection(edge.source, edge.target);
        const active = picked || (highlight?.edges.has(edge.id) ?? false);
        const dimmed = highlight !== null && !active;
        const isUncertain = edge.confidence === "ambiguous" || edge.confidence === "likely";
        const typeOnly = edge.type === "references";
        const http = edge.type === "http";
        const color = active ? "var(--color-accent)" : http ? "var(--color-warn)" : "var(--color-line-strong)";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: false,
          // Requests across processes do not have import visibility, and if not marked, they will be treated as an ordinary dependency.
          ...(http
            ? {
                label: "HTTP",
                labelStyle: { fontSize: 9, fill: "var(--color-warn)", fontFamily: "var(--font-mono, monospace)" },
                labelBgStyle: { fill: "var(--color-canvas)", fillOpacity: 0.85 },
                labelBgPadding: [3, 1] as [number, number],
              }
            : {}),
          style: {
            // The border width depends on the coding intensity, and the thinnest should be 1px, otherwise it will disappear on a dark background;
            // Pure type dependencies do not participate in runtime, fixed at the finest granularity
            strokeWidth: (typeOnly ? 1 : 1 + edge.weight * 2.4) + (picked ? 1.5 : 0),
            stroke: color,
            strokeDasharray: typeOnly
              ? "1 5"
              : edge.confidence === "ambiguous" ? "2 4" : edge.confidence === "likely" ? "6 4" : undefined,
            opacity: dimmed ? 0.2 : typeOnly ? 0.45 : isUncertain ? 0.7 : 0.95,
            strokeLinecap: "round",
            transition: "opacity 140ms ease, stroke 140ms ease",
          },
          // Custom solid circles using userSpaceOnUse will not scale with the dependent stroke width.
          markerEnd: active ? ACTIVE_EDGE_DOT_MARKER : EDGE_DOT_MARKER,
          zIndex: active ? 5 : 0,
        };
      }),
    [flat.edges, highlight, selected],
  );

  // Click on an edge to see what it is made of; calling an edge in the graph is a single call, directly showing the called function.
  const onEdgeClick = useCallback<EdgeMouseHandler>((_event, edge) => {
    if (isContractEnd(edge.source) && isContractEnd(edge.target)) select(edgeSelection(edge.source, edge.target));
    else if (edge.target.startsWith("sym:")) select(edge.target);
  }, [select]);

  const onNodeEnter = useCallback<NodeMouseHandler<ScopeNodeType>>(
    (event, node) => {
      hover(node.id, { x: event.clientX, y: event.clientY });
    },
    [hover],
  );

  const onNodeLeave = useCallback<NodeMouseHandler<ScopeNodeType>>(() => {
    hover(null);
  }, [hover]);

  const lastClick = useRef<{ id: string; at: number } | null>(null);

  /**
   * Single-click to select, double-click to expand both go through here.
   *
   * Not using React Flow's onNodeDoubleClick: the browser only registers when both clicks hit
   * A dblclick is only synthesized when it's the same element, but if the main thread is busy (as it will be during the initial layout of a large repository)
   * The node element may be rebuilt between two taps, and the gesture is lost. Double tap is the most
   * Core gestures cannot be conditional on this kind of situation.
   */
  const onNodeClick = useCallback<NodeMouseHandler<ScopeNodeType>>(
    (event, node) => {
      const now = event.timeStamp;
      const prev = lastClick.current;
      const isSecond = prev !== null && prev.id === node.id && now - prev.at <= DOUBLE_CLICK_MS;
      // Clicking three times in a row should not be counted as a double click in two rounds, clear immediately after hitting
      lastClick.current = isSecond ? null : { id: node.id, at: now };

      if (!isSecond) {
        select(node.id);
        return;
      }

      // The first strike had already pushed the drawer open, but the purpose of the double strike was navigation rather than examining the details,
      // Let it continue occupying 400px, just enough to block the content that just expanded
      setDrawerOpen(false);

      if (event.altKey) {
        setFocus(focus === node.id ? null : node.id);
        return;
      }

      // The symbol node in the call graph has no 'next level' to expand, so the natural meaning of double-click becomes
      // "Make it the new center" — follow the call chain all the way down; this is the way to understand a link.
      const dto = node.data.dto;
      if (callGraph && dto.kind === "symbol") {
        void openCallGraph(Number(dto.id.slice("sym:".length)), dto.label);
        return;
      }
      void toggleExpand(dto);
    },
    [select, setDrawerOpen, setFocus, toggleExpand, focus, callGraph, openCallGraph],
  );

  const onNodeContextMenu = useCallback<NodeMouseHandler<ScopeNodeType>>(
    (event, node) => {
      event.preventDefault();
      setMenu({ node: node.data.dto, x: event.clientX, y: event.clientY });
    },
    [],
  );

  if (flat.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-ink-faint)]">
        {loading ? t("正在加载图谱…") : t("这个作用域下没有可显示的内容")}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <EdgeDotMarkers />
      <ReactFlow<ScopeNodeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseLeave={onNodeLeave}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => {
          select(null);
          setMenu(null);
        }}
        onMoveStart={() => setMenu(null)}
        className={framed ? undefined : "graph-unframed"}
        minZoom={0.15}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="var(--color-graph-grid)"
        />
        <Controls
          showInteractive={false}
          className="!border-[var(--color-line)] !bg-[var(--color-surface)]"
        />
      </ReactFlow>

      {layout.pending && (
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1 text-[11px] text-[var(--color-ink-muted)]">
          {t("正在布局…")}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-4 right-4 flex flex-col items-end gap-1.5">
        <LensLegend />
        <div className="rounded-full border border-[var(--color-line)] bg-[var(--color-surface)]/90 px-2.5 py-1 text-[10px] text-[var(--color-ink-faint)] shadow-sm backdrop-blur">
          {horizontal ? t("调用方向：调用方 → 被调用方") : t("依赖方向：使用方 ↓ 被依赖方 · 点边看由什么构成")}
        </div>
      </div>

      <HoverCard />
      {menu && <NodeContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * The end of the connecting line only indicates direction, no longer using the visually heavy triangular arrow. The marker's viewport is still
 * The original 13×13, the dot diameter is close to the height of the old arrow, and it is completely decoupled from the line width.
 */
function EdgeDotMarkers() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute h-0 w-0">
      <defs>
        <marker
          id={EDGE_DOT_MARKER}
          markerWidth="13"
          markerHeight="13"
          markerUnits="userSpaceOnUse"
          orient="auto"
          refX="0"
          refY="0"
          viewBox="-6.5 -6.5 13 13"
        >
          <circle cx="-1" cy="0" r="4" fill="var(--color-line-strong)" />
        </marker>
        <marker
          id={ACTIVE_EDGE_DOT_MARKER}
          markerWidth="13"
          markerHeight="13"
          markerUnits="userSpaceOnUse"
          orient="auto"
          refX="0"
          refY="0"
          viewBox="-6.5 -6.5 13 13"
        >
          <circle cx="-1" cy="0" r="4" fill="var(--color-accent)" />
        </marker>
      </defs>
    </svg>
  );
}

/**
 * Keep the viewport in sync with layout changes, but try to move the camera as little as possible.
 *
 * Handle in two tiers, because users have completely different expectations for these two matters:
 * - The top-level node collection has changed (switching focus, changing scope): the entire diagram is different, center it directly
 *   Adaptation. The first screen also falls into this category, but without old footage to transition through, it changes to a fade-in to settle.
 * - Just expanded a certain node: the user's attention is pinned on that node, and pulling the camera away will
 *   Discard the spatial memory he just established. So only move it when the new content actually runs out of the viewport,
 *   And give priority to translation; avoid scaling whenever possible.
 *
 * Calculate the bounding box yourself instead of using fitView: fitView has to wait for React Flow to measure each node.
 * That timing is later than the deployment and is unreliable, while the coordinates returned by ELK are authoritative values.
 */
function useAutoViewport(nodes: PositionedNode[], version: number, attention: string | null): boolean {
  const { setViewport, getViewport } = useReactFlow();
  const paneWidth = useFlowStore((s) => s.width);
  const paneHeight = useFlowStore((s) => s.height);
  const lastFittedKey = useRef<string | null>(null);
  /** The layout version when the diagram is cleared. After clearing, the returning nodes will initially carry the coordinates from the previous version, and the updated version needs to be finalized before measurements can be taken. */
  const emptiedAt = useRef(0);
  /** Before the first shot is in place, the node is still in the default viewport and should not be revealed. */
  const [framed, setFramed] = useState(false);

  const roots = useMemo(() => nodes.filter((n) => n.parentId === null), [nodes]);
  const rootKey = useMemo(() => roots.map((n) => n.dto.id).join("|"), [roots]);

  useEffect(() => {
    // In Figure 1, ReactFlow is unloaded (when cutting noise, external dependencies, or calling graphs externally, it needs to be reloaded).
    // By the time it was hung up again, the lens had returned to the default origin. From there, the transition made the whole image appear as if it was drifting in from the top left corner,
    // So treat it as the first screen: hide it first, then let it fade in from the middle after the new layout is implemented, just like switching warehouses.
    if (roots.length === 0) {
      if (lastFittedKey.current !== null) {
        lastFittedKey.current = null;
        emptiedAt.current = version;
        setFramed(false);
      }
      return;
    }
    if (version <= emptiedAt.current) return;
    if (paneWidth === 0 || paneHeight === 0) return;

    const pane = { width: paneWidth, height: paneHeight };
    // The size of the top-level nodes already includes their expanded subtrees, so looking only at the top level gives the bounding box of the entire graph.
    const whole = unionBox(roots.map((n) => ({ ...n, x: n.x, y: n.y })));

    if (rootKey !== lastFittedKey.current) {
      const first = lastFittedKey.current === null;
      lastFittedKey.current = rootKey;
      const anchor = attention !== null ? absoluteBox(nodes, attention) : null;
      const target = clampToContent(frameGraph(whole, anchor, pane), whole, pane);
      if (!first) {
        void setViewport(target, { duration: FIT_DURATION });
        return;
      }
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      void setViewport(still ? target : scaleAroundCenter(target, pane, SETTLE_FROM_SCALE), { duration: 0 });
      setFramed(true);
      if (!still) {
        // Linear interpolation: The default smooth first zooms out then zooms in, and when it settles slightly, it actually feels like a single jump.
        void setViewport(target, { duration: SETTLE_DURATION, ease: easeOutCubic, interpolate: "linear" });
      }
      return;
    }

    // If the entire image can still fit within a readable zoom level, then fit it. This often happens when expanding one or two layers.
    // At this time, chasing the node that has just expanded will push the row of its siblings above it off the screen—they are hidden in the top bar
    // If you can't see or click the bottom, people can't go back to the brother layer. When everything can be seen, show it all to him.
    if (fitsReadably(whole, pane)) {
      void setViewport(clampToContent(centerOn(whole, pane), whole, pane), {
        duration: FIT_DURATION,
      });
      return;
    }

    // Only when it can't fit do you follow the attention. After drilling down three or four levels, the entire map has already become too large to read on a single screen.
    // Forcing it to fit will only compress all the text into noise—at this point, what the user really wants to see is just the part that was opened.
    const target = (attention !== null ? absoluteBox(nodes, attention) : null) ?? whole;
    const next = nudgeIntoView(target, pane, getViewport());
    if (next) void setViewport(clampToContent(next, whole, pane), { duration: FIT_DURATION });
    // Each layout of roots is a new array reference, and the real trigger condition is rootKey + version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootKey, version, attention, paneWidth, paneHeight, setViewport, getViewport]);

  return framed;
}

/** Zooming with the viewport center as the fixed point makes the image look like it is slightly zooming in place, rather than panning as a whole. */
function scaleAroundCenter(viewport: Viewport, pane: { width: number; height: number }, factor: number): Viewport {
  const cx = pane.width / 2;
  const cy = pane.height / 2;
  return {
    x: cx - (cx - viewport.x) * factor,
    y: cy - (cy - viewport.y) * factor,
    zoom: viewport.zoom * factor,
  };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function unionBox(boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): Box {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...boxes.map((b) => b.x + b.width)) - minX),
    height: Math.max(1, Math.max(...boxes.map((b) => b.y + b.height)) - minY),
  };
}

/** The coordinates given by ELK are relative to the parent node, and you need to add them all the way up to the root to get the canvas coordinates. */
function absoluteBox(nodes: PositionedNode[], id: string): Box | null {
  const byId = new Map(nodes.map((n) => [n.dto.id, n]));
  const node = byId.get(id);
  if (!node) return null;

  let x = node.x;
  let y = node.y;
  for (let cursor = node.parentId; cursor !== null; ) {
    const parent = byId.get(cursor);
    if (!parent) break;
    x += parent.x;
    y += parent.y;
    cursor = parent.parentId;
  }
  return { x, y, width: node.width, height: node.height };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Put the box into the viewport: center it if it fits, align it to the top left if it doesn't.
 *
 * Centering when overflowing means that the user sees the middle part of the content, with both ends cut off; aligned to the top left corner.
 * At least it can be read from the beginning, which also aligns with the layered layout's direction of 'upstream on top'.
 */
/**
 * How to set up the camera when switching to a different image.
 *
 * If it can fit within the readable zoom, adapt the whole image; if it can't fit, center it by the anchor point. Text below 0.5 zoom
 * It's already noise, and 'see all' at this point is not a valuable goal — instead, it shows the images that can't fit.
 * Aligning to the top left will make the node that the user just clicked on fall directly outside the screen.
 */
function frameGraph(
  whole: Box,
  anchor: Box | null,
  pane: { width: number; height: number },
): Viewport {
  const usable = 1 - FIT_PADDING * 2;
  const fitZoom = Math.min(
    (pane.width * usable) / whole.width,
    (pane.height * usable) / whole.height,
  );
  if (fitZoom >= FIT_MIN_ZOOM || anchor === null) return centerOn(whole, pane);

  return {
    zoom: FIT_MIN_ZOOM,
    x: pane.width / 2 - (anchor.x + anchor.width / 2) * FIT_MIN_ZOOM,
    y: pane.height / 2 - (anchor.y + anchor.height / 2) * FIT_MIN_ZOOM,
  };
}

/** Can the whole image fit into the viewport at a zoom level where the text is still readable? */
function fitsReadably(whole: Box, pane: { width: number; height: number }): boolean {
  const usable = 1 - FIT_PADDING * 2;
  const fitZoom = Math.min(
    (pane.width * usable) / whole.width,
    (pane.height * usable) / whole.height,
  );
  return fitZoom >= FIT_MIN_ZOOM;
}

function centerOn(box: Box, pane: { width: number; height: number }): Viewport {
  const usable = 1 - FIT_PADDING * 2;
  const zoom = clamp(
    Math.min((pane.width * usable) / box.width, (pane.height * usable) / box.height),
    FIT_MIN_ZOOM,
    FIT_MAX_ZOOM,
  );
  const margin = Math.min(pane.width, pane.height) * FIT_PADDING;
  const overflowsX = box.width * zoom > pane.width - margin * 2;
  const overflowsY = box.height * zoom > pane.height - margin * 2;

  return {
    zoom,
    x: overflowsX ? margin - box.x * zoom : pane.width / 2 - (box.x + box.width / 2) * zoom,
    y: overflowsY ? margin - box.y * zoom : pane.height / 2 - (box.y + box.height / 2) * zoom,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamp the viewport back within the content boundaries, preventing the canvas from scrolling too far.
 *
 * When you expand a node, the camera follows it, but ELK might place it below — if you chase it, it will
 * The row of sibling nodes above extends beyond the visible area of the canvas. They are neither visible nor clickable under the top bar.
 * Progressive drilling down precisely requires people to be able to backtrack to the sibling level at any time, so this step is necessary.
 *
 * The rule is any regular behavior that allows the canvas to be moved: if the content fits, keep the whole piece within view; if it doesn't fit
 * Scrolling is allowed, but it is not permitted to scroll past either end.
 */
function clampToContent(
  viewport: Viewport,
  whole: Box,
  pane: { width: number; height: number },
): Viewport {
  const { zoom } = viewport;
  const margin = Math.min(pane.width, pane.height) * FIT_PADDING;

  // They correspond respectively to the two extreme positions of 'content aligned to the left/top margin' and 'content aligned to the right/bottom margin'.
  // When the content fits, the former is the lower bound; when it doesn't fit, it is the upper bound. Both min and max situations are valid.
  const xAtStart = margin - whole.x * zoom;
  const xAtEnd = pane.width - margin - (whole.x + whole.width) * zoom;
  const yAtStart = margin - whole.y * zoom;
  const yAtEnd = pane.height - margin - (whole.y + whole.height) * zoom;

  return {
    zoom,
    x: clamp(viewport.x, Math.min(xAtStart, xAtEnd), Math.max(xAtStart, xAtEnd)),
    y: clamp(viewport.y, Math.min(yAtStart, yAtEnd), Math.max(yAtStart, yAtEnd)),
  };
}

/**
 * Return the minimum viewport change required for the box to re-enter the view; return null if it is already visible.
 *
 * Only when it can't fit does it return to center fit; if it can fit, it only translates, so usually expanding a node is just
 * Move the screen slightly, and the user can still recognize the original position.
 */
function nudgeIntoView(
  box: Box,
  pane: { width: number; height: number },
  current: Viewport,
): Viewport | null {
  const margin = Math.min(pane.width, pane.height) * FIT_PADDING;
  const scaled = { width: box.width * current.zoom, height: box.height * current.zoom };

  if (scaled.width > pane.width - margin * 2 || scaled.height > pane.height - margin * 2) {
    return centerOn(box, pane);
  }

  const left = current.x + box.x * current.zoom;
  const top = current.y + box.y * current.zoom;
  const right = left + scaled.width;
  const bottom = top + scaled.height;

  let dx = 0;
  let dy = 0;
  if (left < margin) dx = margin - left;
  else if (right > pane.width - margin) dx = pane.width - margin - right;
  if (top < margin) dy = margin - top;
  else if (bottom > pane.height - margin) dy = pane.height - margin - bottom;

  // A deviation of one or two pixels is not worth triggering an animation.
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  return { zoom: current.zoom, x: current.x + dx, y: current.y + dy };
}

interface RenderContext {
  metric: MetricKey;
  selected: string | null;
  hovered: string | null;
  highlight: { neighbors: Set<string>; edges: Set<string> } | null;
  lowDetail: boolean;
  labels: Map<string, string>;
  /** The layout direction is RIGHT, and the connection points should be attached on both the left and right sides. */
  horizontal: boolean;
  truncatedByScope: Record<string, number>;
}

function toFlowNode(node: PositionedNode, ctx: RenderContext): ScopeNodeType {
  const active = ctx.hovered === node.dto.id;
  const related = ctx.highlight?.neighbors.has(node.dto.id) ?? false;
  // Containers do not participate in dimming: darkening the parent container will make the highlighted child nodes inside look very dirty
  const dimmed = ctx.highlight !== null && !active && !related && !node.isContainer;

  return {
    id: node.dto.id,
    type: "scope",
    position: { x: node.x, y: node.y },
    parentId: node.parentId ?? undefined,
    extent: node.parentId !== null ? "parent" : undefined,
    draggable: true,
    // The size must go through the top-level width/height, it cannot just be written in the style. React Flow will
    // Nodes whose size has not been measured are marked as visibility:hidden, and hidden elements do not participate
    // Hit test—Each time the nodes array is rebuilt, nodes temporarily lose response. Double-click to do so
    // Random failure. The size of the ELK is originally the authoritative value, just tell it directly, even skipping the measurement.
    width: node.width,
    height: node.height,
    zIndex: node.isContainer ? 0 : node.depth + 1,
    data: {
      dto: node.dto,
      label: ctx.labels.get(node.dto.id) ?? node.dto.label,
      metric: ctx.metric,
      isContainer: node.isContainer,
      selected: ctx.selected === node.dto.id,
      active,
      related,
      dimmed,
      lowDetail: ctx.lowDetail,
      horizontal: ctx.horizontal,
      truncatedInside: node.isContainer ? (ctx.truncatedByScope[node.dto.id] ?? 0) : 0,
    },
  };
}

export { nodeAccent };
