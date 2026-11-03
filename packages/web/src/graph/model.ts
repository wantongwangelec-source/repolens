import type { GraphDto, GraphEdgeDto, GraphNodeDto } from "@repolens/core/types";

/**
 * The minimum state slice required for the puzzle.
 *
 * Deliberately not receiving the entire store: when the canvas re-renders once, all nodes need to be rebuilt, and hover
 * This type of high-frequency state is unrelated to the structure of the graph; if it gets mixed in, it will turn scanning across the graph into continuous rearrangement.
 */
export interface GraphSlice {
  rootScope: string;
  subgraphs: Record<string, GraphDto>;
  expanded: string[];
  hiddenNodes: string[];
}

export interface FlatNode {
  dto: GraphNodeDto;
  parentId: string | null;
  depth: number;
  /** Whether this node is in an expanded state (i.e., rendered as a container) */
  isContainer: boolean;
}

export interface FlatGraph {
  nodes: FlatNode[];
  edges: GraphEdgeDto[];
  /** The number of items folded away in each container, used for the corner mark of stacked cards */
  truncatedByScope: Record<string, number>;
}

/**
 * Assemble the 'subgraphs loaded by scope' into a renderable nested structure.
 *
 * Here is the core of progressive drill-down: the expanded state is just a collection of IDs, the real hierarchy is
 * It is re-derived according to the loaded subgraph each time it is rendered. This way, expanding/collapsing is not necessary.
 * Maintaining any incremental tree structure will prevent inconsistencies between state and data.
 */
export function flattenGraph(slice: GraphSlice): FlatGraph {
  const { rootScope, subgraphs, expanded, hiddenNodes } = slice;
  const expandedSet = new Set(expanded);
  const hidden = new Set(hiddenNodes);

  const nodes: FlatNode[] = [];
  const edges: GraphEdgeDto[] = [];
  const truncatedByScope: Record<string, number> = {};
  const seen = new Set<string>();

  const visit = (scopeId: string, parentId: string | null, depth: number): void => {
    const graph = subgraphs[scopeId];
    if (!graph) return;

    truncatedByScope[scopeId] = graph.truncated;

    for (const dto of graph.nodes) {
      if (hidden.has(dto.id) || seen.has(dto.id)) continue;
      seen.add(dto.id);

      const isContainer = expandedSet.has(dto.id) && subgraphs[dto.id] !== undefined;
      nodes.push({ dto, parentId, depth, isContainer });

      if (isContainer) visit(dto.id, dto.id, depth + 1);
    }

    for (const edge of graph.edges) {
      if (hidden.has(edge.source) || hidden.has(edge.target)) continue;
      edges.push(edge);
    }
  };

  visit(rootScope, null, 0);

  // After expanding a container, the edge pointing to the container as a whole still has meaning (it represents 'this entire block is being depended on').
  // So do not perform redirection, just remove the self-loops where both ends fall within the same container.
  const present = new Set(nodes.map((n) => n.dto.id));
  const deduped = new Map<string, GraphEdgeDto>();
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    const existing = deduped.get(edge.id);
    if (existing) {
      existing.count += edge.count;
      continue;
    }
    deduped.set(edge.id, { ...edge });
  }

  return { nodes, edges: [...deduped.values()], truncatedByScope };
}

/**
 * Focus mode: Only keep nodes connected to the focus node within a depth of jumps, along with the content they expand.
 *
 * Undirected expansion rather than only looking at outgoing edges — when the user asks, 'Who is related to it?'
 * The caller and the callee are equally important.
 */
export function applyFocus(graph: FlatGraph, focus: string | null, depth: number): FlatGraph {
  if (focus === null) return graph;
  if (!graph.nodes.some((n) => n.dto.id === focus)) return graph;

  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    const bucket = adjacency.get(a) ?? new Set<string>();
    bucket.add(b);
    adjacency.set(a, bucket);
  };
  for (const edge of graph.edges) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }

  const keep = new Set<string>([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (keep.has(neighbor)) continue;
        keep.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // The remaining nodes expand, even including those inside: the edges of the subgraph only connect siblings on the same level, between the expanded child nodes and the focus
  // Without a border, double-clicking to expand the focus will only result in an empty box. It's just a container left by the ancestor and doesn't carry further down.
  // Otherwise, focusing deeply on one file will bring back the entire package.
  const children = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.parentId === null) continue;
    const bucket = children.get(node.parentId);
    if (bucket) bucket.push(node.dto.id); else children.set(node.parentId, [node.dto.id]);
  }
  const pending = [...keep];
  while (pending.length > 0) {
    for (const child of children.get(pending.pop() as string) ?? []) {
      if (keep.has(child)) continue;
      keep.add(child);
      pending.push(child);
    }
  }

  // The ancestor container must be retained, otherwise the child nodes will lose the parent node pointed to by parentId.
  for (const node of graph.nodes) {
    if (!keep.has(node.dto.id)) continue;
    let cursor = node.parentId;
    while (cursor !== null) {
      keep.add(cursor);
      cursor = graph.nodes.find((n) => n.dto.id === cursor)?.parentId ?? null;
    }
  }

  return {
    nodes: graph.nodes.filter((n) => keep.has(n.dto.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    truncatedByScope: graph.truncatedByScope,
  };
}

/**
 * Directly find a node in the loaded subgraph.
 *
 * Hover preview only requires one node, using flattenGraph to replace it means every time the mouse
 * Moving rebuilds the entire tree all over again.
 */
export function findNode(subgraphs: Record<string, GraphDto>, nodeId: string): GraphNodeDto | null {
  for (const graph of Object.values(subgraphs)) {
    const hit = graph.nodes.find((n) => n.id === nodeId);
    if (hit) return hit;
  }
  return null;
}

export function neighborIds(edges: readonly GraphEdgeDto[], nodeId: string): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    if (edge.source === nodeId) out.add(edge.target);
    else if (edge.target === nodeId) out.add(edge.source);
  }
  return out;
}

export function incidentEdgeIds(edges: readonly GraphEdgeDto[], nodeId: string): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    if (edge.source === nodeId || edge.target === nodeId) out.add(edge.id);
  }
  return out;
}
