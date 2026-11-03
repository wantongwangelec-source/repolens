import type { GraphDto, GraphNodeDto, OverviewDto } from "@repolens/core/types";
import { describe, expect, it } from "vitest";
import { type NodeScope, inScope, scopeOf } from "./scope";

const metrics = { loc: 1, files: 1, symbols: 1, complexity: 1, inDegree: 0, outDegree: 0 };

function graph(...nodes: Array<Pick<GraphNodeDto, "id" | "kind" | "label" | "path">>): Record<string, GraphDto> {
  return { root: { nodes: nodes.map((n) => ({ ...n, metrics, childCount: 0, expandable: false })), edges: [], truncated: 0 } };
}

const packages: OverviewDto["packages"] = [
  { id: "pkg:@repolens/core", name: "@repolens/core", dir: "packages/core", manager: "pnpm", loc: 1, files: 1 },
];

describe("scopeOf", () => {
  it("图里有的节点直接取它的路径，符号落到所在文件", () => {
    const subgraphs = graph(
      { id: "file:7", kind: "file", label: "walk.ts", path: "packages/core/src/db/walk.ts" },
      { id: "sym:9", kind: "symbol", label: "unresolvedReason", path: "packages/core/src/db/walk.ts" },
    );
    expect(scopeOf("file:7", subgraphs, packages)).toMatchObject({ kind: "file", path: "packages/core/src/db/walk.ts" });
    expect(scopeOf("sym:9", subgraphs, packages)).toMatchObject({ kind: "symbol", path: "packages/core/src/db/walk.ts" });
  });

  it("目录、包、没进索引的文件不用查图；没加载的文件和符号交给服务端", () => {
    expect(scopeOf("dir:packages/web/src", {}, packages)).toMatchObject({ kind: "directory", label: "src", path: "packages/web/src" });
    expect(scopeOf("pkg:@repolens/core", {}, packages)).toMatchObject({ kind: "package", path: "packages/core" });
    expect(scopeOf("raw:dist/index.js", {}, packages)).toMatchObject({ kind: "file", path: "dist/index.js" });
    expect(scopeOf("file:42", {}, packages)).toBeUndefined();
    expect(scopeOf("sym:42", {}, packages)).toBeUndefined();
    expect(scopeOf("external", {}, packages)).toBeNull();
    expect(scopeOf("agg:root:3", graph({ id: "agg:root:3", kind: "aggregate", label: "其他 3 项" }), packages)).toBeNull();
  });
});

describe("inScope", () => {
  const dir: NodeScope = { id: "dir:packages/core", kind: "directory", label: "core", path: "packages/core" };
  const file: NodeScope = { id: "file:7", kind: "file", label: "walk.ts", path: "packages/core/src/db/walk.ts" };
  const symbol: NodeScope = { id: "sym:9", kind: "symbol", label: "unresolvedReason", path: "packages/core/src/db/walk.ts" };

  it("目录按路径前缀包含，不把同名前缀的兄弟目录算进来", () => {
    expect(inScope(dir, "packages/core/src/db/walk.ts")).toBe(true);
    expect(inScope(dir, "packages/core")).toBe(true);
    expect(inScope(dir, "packages/core-utils/index.ts")).toBe(false);
    expect(inScope({ ...dir, path: "." }, "anything/at/all.ts")).toBe(true);
  });

  it("文件只认自己；符号带 id 时按 id 比，不带时退回到所在文件", () => {
    expect(inScope(file, "packages/core/src/db/walk.ts", "sym:1")).toBe(true);
    expect(inScope(file, "packages/core/src/db/queries.ts")).toBe(false);
    expect(inScope(symbol, "packages/core/src/db/walk.ts", "sym:9")).toBe(true);
    expect(inScope(symbol, "packages/core/src/db/walk.ts", "sym:10")).toBe(false);
    expect(inScope(symbol, "packages/core/src/db/walk.ts", null)).toBe(false);
    expect(inScope(symbol, "packages/core/src/db/walk.ts")).toBe(true);
  });
});
