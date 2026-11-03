import type { GraphEdgeDto, GraphNodeDto } from "@repolens/core/types";
import type { ElkNode } from "elkjs/lib/elk-api";
import * as elkModule from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import type { FlatGraph, FlatNode } from "../model";
import { resolveElkConstructor } from "./engine";
import { layoutFlatGraph } from "./useElkLayout";

const Elk = resolveElkConstructor(elkModule);
const elk = new Elk() as { layout: (graph: ElkNode) => Promise<ElkNode> };

function node(id: string, parentId: string | null = null, isContainer = false): FlatNode {
  const dto: GraphNodeDto = {
    id,
    kind: id.startsWith("pkg:") ? "package" : id.startsWith("dir:") ? "directory" : "file",
    label: id,
    metrics: { loc: 1, files: 1, symbols: 1, complexity: 1, inDegree: 0, outDegree: 0 },
    childCount: 0,
    expandable: isContainer,
  };
  return { dto, parentId, depth: parentId === null ? 0 : 1, isContainer };
}

function edge(source: string, target: string): GraphEdgeDto {
  return { id: `${source}->${target}`, source, target, type: "imports", confidence: "exact", weight: 0.3, count: 1 };
}

const sizeOf = () => ({ width: 188, height: 58 });

/** The appearance of this repository after expanding server/src: web only depends on core, and no one depends on web */
function expandedServer(): FlatGraph {
  const src = "dir:server/src";
  return {
    nodes: [
      node("pkg:cli"),
      node("pkg:core"),
      node("pkg:server", null, true),
      node(src, "pkg:server", true),
      node("file:index", src),
      node("file:scan-worker", src),
      node("file:picker", src),
      node("file:pool", src),
      node("file:manager", src),
      node("file:api", src),
      node("pkg:web"),
    ],
    edges: [
      edge("pkg:cli", "pkg:core"),
      edge("pkg:cli", "pkg:server"),
      edge("pkg:server", "pkg:core"),
      edge("pkg:web", "pkg:core"),
      edge("file:index", "file:picker"),
      edge("file:index", "file:pool"),
      edge("file:index", "file:manager"),
      edge("file:index", "file:api"),
      edge("file:pool", "file:api"),
    ],
    truncatedByScope: {},
  };
}

type Positions = Map<string, { x: number; y: number; width: number; height: number }>;

function layout(graph: FlatGraph): Promise<Positions> {
  return layoutFlatGraph(graph, sizeOf, "DOWN", (g) => elk.layout(g));
}

describe("结构图分层", () => {
  it("没人依赖的节点排在最上层，不会被挤到它依赖的节点旁边", async () => {
    const positions = await layout(expandedServer());
    const y = (id: string) => positions.get(id)!.y;
    expect(y("pkg:web")).toBe(y("pkg:cli"));
    expect(y("pkg:web")).toBeLessThan(y("pkg:server"));
    expect(y("pkg:server")).toBeLessThan(y("pkg:core"));
  });

  it("仍然横竖对齐：同层同高，节点都落在同一套列线上", async () => {
    const graph: FlatGraph = {
      nodes: ["a", "b", "c", "d", "e", "f"].map((id) => node(`file:${id}`)),
      edges: [
        edge("file:a", "file:c"),
        edge("file:a", "file:d"),
        edge("file:b", "file:d"),
        edge("file:c", "file:f"),
        edge("file:d", "file:e"),
        edge("file:b", "file:f"),
      ],
      truncatedByScope: {},
    };
    const positions = await layout(graph);
    const centers = [...positions.values()].map((p) => p.x + p.width / 2);
    const step = 188 + 28;
    const offset = centers[0]! % step;
    for (const center of centers) expect((center - offset) % step).toBeCloseTo(0, 5);
    const rows = new Set([...positions.values()].map((p) => p.y));
    expect(rows.size).toBeLessThan(positions.size);
  });
});
