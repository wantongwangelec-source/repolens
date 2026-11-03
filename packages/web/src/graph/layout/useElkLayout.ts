import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FlatGraph, FlatNode } from "../model";
import { LayoutEngine } from "./engine";

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 58;
/** Leave space at the top of the container for the height of the title bar */
export const CONTAINER_HEADER = 34;
const HORIZONTAL_GAP = 28;
const ROOT_PADDING = 16;
const CONTAINER_SIDE_PADDING = 16;
const CONTAINER_BOTTOM_PADDING = 16;
/**
 * ELK can produce a few pixels of y-axis error due to differences in node height. Values smaller than this are still considered the same layer.
 * Otherwise, a row of nodes would be mistakenly split into several rows. There is at least 44px between truly adjacent layers, making the boundary sufficiently safe.
 */
const LAYER_CENTER_TOLERANCE = 24;

export interface PositionedNode extends FlatNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  /** Is the layout still being calculated, used to display skeletons instead of blanks */
  pending: boolean;
  /** Automatically increments each time a new coordinate is added, and the caller uses it to determine 'the viewport needs to be readjusted' */
  version: number;
}

/**
 * The structure diagram goes downward, and the call diagram goes to the right.
 *
 * It's not an aesthetic preference: the structure diagram has few levels, but each level is wide (dozens of files in one directory), arranged downward
 * Only then can each layer spread out horizontally; the graph call is the opposite, the number of layers is determined by the number of jumps, and each layer is a column of neighbors,
 * Aligning to the right just puts 'caller → it → callee' into a left-to-right flow, and also
 * A dozen or so neighbors were placed upright within the screen height, rather than squeezed horizontally onto the canvas.
 */
const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  // Cross-level edges are handled by ELK itself, so all edges can be attached to the root.
  // The front end does not need to calculate the lowest common ancestor
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "24",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.cycleBreaking.strategy": "GREEDY_MODEL_ORDER",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  "elk.layered.crossingMinimization.semiInteractive": "true",
  "elk.padding": `[top=${CONTAINER_HEADER + 12},left=16,bottom=16,right=16]`,
};

/**
 * Give the flattened map to the Worker for layout, and return nodes with absolute/relative coordinates.
 *
 * Layout requests with auto-increment IDs only accept the latest result: this can occur when users quickly click to expand.
 * With multiple concurrent requests, late old results can cause the screen to jump back to the previous state.
 */
export function useElkLayout(
  graph: FlatGraph,
  sizeOf: (node: FlatNode) => { width: number; height: number },
  direction: "DOWN" | "RIGHT" = "DOWN",
): LayoutResult {
  const engineRef = useRef<LayoutEngine | null>(null);
  const requestId = useRef(0);
  const [result, setResult] = useState<{
    positions: Map<string, { x: number; y: number; width: number; height: number }>;
    version: number;
  }>({ positions: new Map(), version: 0 });
  const [pending, setPending] = useState(false);
  const { positions, version } = result;

  useEffect(() => {
    const engine = new LayoutEngine();
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const signature = useMemo(
    () =>
      JSON.stringify([
        direction,
        graph.nodes.map((n) => [n.dto.id, n.parentId, n.isContainer, sizeOf(n).width, sizeOf(n).height]),
        graph.edges.map((e) => [e.source, e.target]),
      ]),
    // sizeOf is a new function reference every time it renders, but its output has already been serialized into the signature
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, direction],
  );

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || graph.nodes.length === 0) {
      // The version only increments when it lands on the real coordinates: the caller relies on it to determine that 'the coordinates currently read are trustworthy.'
      // If clearing is also counted as one time, the first screen adaptation will detect a bunch of nodes that are still at the origin.
      setResult((prev) => (prev.positions.size === 0 ? prev : { positions: new Map(), version: prev.version }));
      return;
    }

    // If the user rapidly clicks to expand, multiple concurrent requests will be generated, and only the result of the last one is accepted.
    // Otherwise, the old layout that arrives late will drag the screen back to the previous state.
    const id = ++requestId.current;
    setPending(true);

    void layoutFlatGraph(graph, sizeOf, direction, (elkGraph) => engine.layout(elkGraph))
      .then((positions) => {
        if (id !== requestId.current) return;
        setResult((prev) => ({ positions, version: prev.version + 1 }));
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setResult((prev) => ({ positions: new Map(), version: prev.version }));
      })
      .finally(() => {
        if (id === requestId.current) setPending(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const nodes = useMemo<PositionedNode[]>(
    () =>
      graph.nodes.map((node) => {
        const pos = positions.get(node.dto.id);
        const fallback = sizeOf(node);
        return {
          ...node,
          x: pos?.x ?? 0,
          y: pos?.y ?? 0,
          width: pos?.width ?? fallback.width,
          height: pos?.height ?? fallback.height,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes, positions],
  );

  return { nodes, pending: pending && positions.size === 0, version };
}

/** The layout itself does not depend on React or Worker; it can only be directly verified in Node when taken out separately. */
export async function layoutFlatGraph(
  graph: FlatGraph,
  sizeOf: (node: FlatNode) => { width: number; height: number },
  direction: "DOWN" | "RIGHT",
  layout: (graph: ElkNode) => Promise<ElkNode>,
): Promise<Map<string, { x: number; y: number; width: number; height: number }>> {
  const laid = await layout(buildElkGraph(graph, sizeOf, direction));
  // ELK is very good at determining dependency hierarchies, but it will freely move the horizontal positions of each layer just to reduce a few crossings.
  // The structure diagram retains the hierarchy it calculates, and then the nodes on the same level are placed back into a stable column grid: this way, upstream and downstream still
  // Correct, at the same time, layers with the same number of rows will be strictly vertically aligned, and their positions before and after unfolding are also easier to predict.
  if (direction === "DOWN") alignDownwardGrid(laid);
  return collectPositions(laid);
}

/** For structure diagrams only, the root and each container must be specified, otherwise the contents inside the container will still follow the default layout. */
const DOWNWARD_OPTIONS: Record<string, string> = {
  // Nodes that no one depends on are placed at the top, and each subsequent row below indicates how far they are from these entry points. This is the default.
  // The strategy seeks the shortest connection, which will push the entrances that rely only on the lower level downwards, making them appear like the depended-on party.
  "elk.layered.layering.strategy": "LONGEST_PATH_SOURCE",
  // The same-layer order and horizontal coordinates will be rearranged by alignDownwardGrid, and the connections are handled by React Flow according to the nodes
  // Position redraws, ELK's optimizations in these steps are not useful, yet it takes up the majority of the time in large graph layouts.
  // Cross minimization can only be completely turned off when there are no expanded containers; if there are containers, turning it off will cause ELK to get disordered.
  // Even if an exception is thrown inside the container, the iteration can only be minimized.
  "elk.layered.thoroughness": "1",
  "elk.layered.nodePlacement.strategy": "SIMPLE",
  // Orthogonal wiring will increase the layer spacing according to the number of lines, causing the container to become taller for no reason.
  "elk.edgeRouting": "POLYLINE",
};

function buildElkGraph(
  graph: FlatGraph,
  sizeOf: (node: FlatNode) => { width: number; height: number },
  direction: "DOWN" | "RIGHT",
): ElkNode {
  const flat = graph.nodes.every((node) => !node.isContainer);
  const directional =
    direction !== "DOWN"
      ? {}
      : flat
        ? { ...DOWNWARD_OPTIONS, "elk.layered.crossingMinimization.strategy": "NONE" }
        : DOWNWARD_OPTIONS;
  const byParent = new Map<string | null, FlatNode[]>();
  for (const node of graph.nodes) {
    const bucket = byParent.get(node.parentId) ?? [];
    bucket.push(node);
    byParent.set(node.parentId, bucket);
  }

  const build = (parentId: string | null): ElkNode[] =>
    (byParent.get(parentId) ?? []).map((node) => {
      const children = build(node.dto.id);
      const size = sizeOf(node);
      if (children.length === 0) {
        return { id: node.dto.id, width: size.width, height: size.height };
      }
      return {
        id: node.dto.id,
        children,
        layoutOptions: {
          "elk.padding": LAYOUT_OPTIONS["elk.padding"] as string,
          "elk.spacing.nodeNode": "20",
          "elk.layered.spacing.nodeNodeBetweenLayers": "44",
          ...directional,
        },
      };
    });

  const edges: ElkExtendedEdge[] = [...graph.edges]
    .sort((a, b) =>
      a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id),
    )
    .map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    }));

  return {
    id: "root",
    layoutOptions: {
      ...LAYOUT_OPTIONS,
      "elk.direction": direction,
      ...directional,
      // The left-right order is stably provided by the server: packages/directories/files follow the path, and symbols follow the source code lines.
      // It is not allowed to swap nodes just to reduce one crossing line; otherwise, it will be difficult to find the target after refreshing the same graph.
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    },
    children: build(null),
    edges,
  };
}

interface GridLayer {
  originalCenter: number;
  nodes: ElkNode[];
}

/**
 * Organize ELK's vertical layering results into a readable column grid.
 *
 * - The y layer fully follows ELK, so the dependency direction and loop splitting remain unchanged;
 * - Nodes on the same layer are arranged in the order of the input model, rather than randomly interchanged due to cross-layer optimization;
 * - Each layer is centered around the same central axis and uses the same column spacing, allowing sparse layers to align with adjacent layers.
 * - The container processes recursively and recalculates its size according to the new content to prevent child nodes from overflowing the border after expansion.
 */
function alignDownwardGrid(parent: ElkNode, root = true): void {
  const children = parent.children;
  if (!children || children.length === 0) return;

  // The ELK layers must be recorded before recursively rewriting the sizes of child containers. After the container becomes taller, group by the center point.
  // Containers and regular nodes that were originally on the same layer might be mistakenly judged as two different layers.
  const order = new Map(children.map((node, index) => [node.id, index]));
  const layers = groupIntoLayers(children);
  for (const child of children) alignDownwardGrid(child, false);

  const ordinaryWidths = children
    .filter((node) => !node.children || node.children.length === 0)
    .map((node) => node.width ?? NODE_WIDTH);
  const columnWidth = Math.max(NODE_WIDTH, ...ordinaryWidths);
  const columnStep = columnWidth + HORIZONTAL_GAP;
  const maxColumns = Math.max(...layers.map((layer) => layer.nodes.length));
  const betweenLayers = root ? 64 : 44;
  const topPadding = root ? ROOT_PADDING : CONTAINER_HEADER + 12;
  const sidePadding = root ? ROOT_PADDING : CONTAINER_SIDE_PADDING;
  const bottomPadding = root ? ROOT_PADDING : CONTAINER_BOTTOM_PADDING;

  let y = topPadding;
  let minEdge = Number.POSITIVE_INFINITY;
  let maxEdge = Number.NEGATIVE_INFINITY;

  for (const layer of layers) {
    layer.nodes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const rowHeight = Math.max(...layer.nodes.map((node) => node.height ?? NODE_HEIGHT));
    const count = layer.nodes.length;
    // All layers share a fixed number of columns, maxColumns. Layers with fewer nodes take the middle section of the columns, instead of
    // Re-center based on your own number of nodes; the latter will cause odd and even rows to always be offset by half a column.
    const firstColumn = Math.floor((maxColumns - count) / 2);
    let previousCenter = Number.NEGATIVE_INFINITY;
    let previousWidth = 0;

    for (let index = 0; index < count; index++) {
      const node = layer.nodes[index]!;
      const width = node.width ?? NODE_WIDTH;
      const height = node.height ?? NODE_HEIGHT;
      const desiredCenter = (firstColumn + index - (maxColumns - 1) / 2) * columnStep;
      // The expanded container may be much wider than a standard column. Normal nodes strictly align with the column lines; only
      // The wide container will push subsequent nodes in the same row to the right to ensure they do not overlap.
      const minimumCenter = previousCenter + previousWidth / 2 + HORIZONTAL_GAP + width / 2;
      const center = Math.max(desiredCenter, minimumCenter);
      node.x = center - width / 2;
      node.y = y + (rowHeight - height) / 2;
      previousCenter = center;
      previousWidth = width;
    }
    minEdge = Math.min(minEdge, ...layer.nodes.map((node) => node.x ?? 0));
    maxEdge = Math.max(
      maxEdge,
      ...layer.nodes.map((node) => (node.x ?? 0) + (node.width ?? NODE_WIDTH)),
    );

    y += rowHeight + betweenLayers;
  }

  // All layers are first arranged with x=0 as the common central axis, and then the whole structure is shifted into the parent container. Retain what ELK provides.
  // A larger size can prevent the container title or ports from being compressed, but the content is always centered within the container.
  const contentWidth = maxEdge - minEdge;
  const requiredWidth = contentWidth + sidePadding * 2;
  const width = Math.max(parent.width ?? 0, requiredWidth);
  const xShift = sidePadding - minEdge + (width - requiredWidth) / 2;
  for (const child of children) child.x = (child.x ?? 0) + xShift;

  // The size of ELK may include decimals, so rounding is done to prevent the nodes below from landing on half pixels and causing blurry borders.
  parent.width = Math.ceil(width);
  parent.height = Math.ceil(Math.max(parent.height ?? 0, y - betweenLayers + bottomPadding));
}

/** Restore the hierarchy according to the vertical center point given by ELK; retain the original model order on the same level. */
function groupIntoLayers(children: readonly ElkNode[]): GridLayer[] {
  const sorted = [...children].sort((a, b) => centerY(a) - centerY(b));
  const layers: GridLayer[] = [];
  for (const node of sorted) {
    const center = centerY(node);
    const last = layers.at(-1);
    if (!last || Math.abs(center - last.originalCenter) > LAYER_CENTER_TOLERANCE) {
      layers.push({ originalCenter: center, nodes: [node] });
      continue;
    }
    last.nodes.push(node);
    last.originalCenter =
      last.nodes.reduce((sum, item) => sum + centerY(item), 0) / last.nodes.length;
  }
  return layers;
}

function centerY(node: ElkNode): number {
  return (node.y ?? 0) + (node.height ?? NODE_HEIGHT) / 2;
}

/** The coordinates returned by ELK are already relative to the parent node, which is consistent with the semantics of parentId in React Flow. */
function collectPositions(
  root: ElkNode,
): Map<string, { x: number; y: number; width: number; height: number }> {
  const out = new Map<string, { x: number; y: number; width: number; height: number }>();
  const visit = (node: ElkNode) => {
    for (const child of node.children ?? []) {
      out.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? NODE_WIDTH,
        height: child.height ?? NODE_HEIGHT,
      });
      visit(child);
    }
  };
  visit(root);
  return out;
}
