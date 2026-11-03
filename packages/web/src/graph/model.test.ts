import type { GraphEdgeDto, GraphNodeDto } from "@repolens/core/types";
import { describe, expect, it } from "vitest";
import { type FlatGraph, type FlatNode, applyFocus } from "./model";

function node(id: string, parentId: string | null = null, isContainer = false): FlatNode {
  const dto: GraphNodeDto = {
    id,
    kind: id.startsWith("dir:") ? "directory" : "file",
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

/** Three directories under src: api depends on db, ui doesn't connect to anyone; api and db are both expanded */
function graph(): FlatGraph {
  return {
    nodes: [
      node("dir:src", null, true),
      node("dir:src/api", "dir:src", true),
      node("file:routes", "dir:src/api"),
      node("file:handlers", "dir:src/api"),
      node("dir:src/db", "dir:src", true),
      node("file:queries", "dir:src/db"),
      node("dir:src/ui", "dir:src"),
    ],
    edges: [edge("dir:src/api", "dir:src/db"), edge("file:routes", "file:handlers")],
    truncatedByScope: {},
  };
}

const ids = (g: FlatGraph) => g.nodes.map((n) => n.dto.id);

describe("applyFocus", () => {
  it("聚焦一个展开的目录时，它里面的文件照常显示", () => {
    const focused = applyFocus(graph(), "dir:src/api", 1);
    expect(ids(focused)).toEqual(expect.arrayContaining(["dir:src/api", "file:routes", "file:handlers"]));
    expect(focused.edges.map((e) => e.id)).toContain("file:routes->file:handlers");
  });

  it("相连的邻居展开着也带上内容，不相连的和只当祖先的不往下带", () => {
    const focused = ids(applyFocus(graph(), "dir:src/api", 1));
    expect(focused).toEqual(expect.arrayContaining(["dir:src/db", "file:queries", "dir:src"]));
    expect(focused).not.toContain("dir:src/ui");

    const deep = ids(applyFocus(graph(), "file:routes", 1));
    expect(deep).toEqual(expect.arrayContaining(["file:routes", "file:handlers", "dir:src/api", "dir:src"]));
    expect(deep).not.toContain("dir:src/db");
    expect(deep).not.toContain("file:queries");
  });
});
