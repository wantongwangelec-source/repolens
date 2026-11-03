import type { ControlBlock, WalkCallDto, WalkFrameDto, WalkTargetDto } from "@repolens/core/types";
import { describe, expect, it } from "vitest";
import { buildSkeleton, displayBlocks, openedBlocks } from "./skeleton";

function target(id: string): WalkTargetDto {
  return { id, name: id, kind: "function", fileId: "file:1", filePath: "a.ts", line: 1, steps: 0, reaches: [] };
}

function call(id: string, options: Partial<WalkCallDto> & { to?: string } = {}): WalkCallDto {
  const { to, ...rest } = options;
  return {
    id, line: 1, column: 0, callee: to ?? id, kind: "call", arguments: [],
    resolution: to ? "exact" : "external", target: to ? target(to) : null, ...rest,
  };
}

function frame(calls: WalkCallDto[]): WalkFrameDto {
  return { id: "sym:1", name: "main", kind: "function", fileId: "file:1", filePath: "a.ts", language: "typescript", startLine: 1, endLine: 30, reaches: [], calls };
}

const guard: ControlBlock = { b: 10, k: "if", t: "!ok", l: 2, x: 1 };
const loop: ControlBlock = { b: 40, k: "loop", t: "for (const x of xs)", l: 5 };

describe("走读骨架", () => {
  it("折叠旁路调用、去掉守卫和 catch 里的调用，被减掉的都记数", () => {
    const calls = [
      call("call:1", { to: "load" }),
      call("call:2", { to: "time", trivial: true }),
      call("call:3", { to: "fail", blocks: [guard] }),
      call("call:4", { to: "recover", blocks: [{ b: 60, k: "catch", t: "err", l: 9 }] }),
      call("call:5", { to: "save" }),
      call("call:6"),
    ];
    const all = buildSkeleton(frame(calls), { all: false, trivial: true, mainPath: false });
    expect(all.steps.map((c) => c.id)).toEqual(["call:1", "call:2", "call:3", "call:4", "call:5"]);

    const main = buildSkeleton(frame(calls), { all: false, trivial: false, mainPath: true });
    expect(main.steps.map((c) => c.id)).toEqual(["call:1", "call:5"]);
    expect(main.folded).toEqual({ trivial: 1, offPath: 2 });
  });

  it("同一块里重复调用同一个函数合成一步，不同分支里的各算各的", () => {
    const calls = [
      call("call:1", { to: "print" }),
      call("call:2", { to: "step" }),
      call("call:3", { to: "print" }),
      call("call:4", { to: "print", blocks: [loop] }),
      call("call:5", { to: "print", blocks: [loop] }),
    ];
    const skeleton = buildSkeleton(frame(calls), { all: false, trivial: true, mainPath: false });
    expect(skeleton.steps.map((c) => c.id)).toEqual(["call:1", "call:2", "call:4"]);
    expect(skeleton.repeats.get("call:1")?.map((c) => c.id)).toEqual(["call:3"]);
    expect(skeleton.repeats.get("call:4")?.map((c) => c.id)).toEqual(["call:5"]);
  });

  it("else 紧跟同一行的 if 合成 else if；块标题只在新进入时出现", () => {
    const elseIf: ControlBlock[] = [{ b: 1, k: "else", t: "a", l: 4 }, { b: 2, k: "if", t: "b", l: 4 }];
    expect(displayBlocks(call("call:1", { blocks: elseIf }))).toEqual([
      { key: "1:2", kind: "else-if", text: "b", line: 4, guard: false },
    ]);

    const first = call("call:1", { blocks: [loop] });
    const second = call("call:2", { blocks: [loop, guard] });
    expect(openedBlocks(null, first).map((o) => [o.block.kind, o.depth])).toEqual([["loop", 0]]);
    expect(openedBlocks(first, second).map((o) => [o.block.kind, o.depth])).toEqual([["if", 1]]);
    expect(openedBlocks(second, first)).toEqual([]);
  });
});
