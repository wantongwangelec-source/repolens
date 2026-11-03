import { describe, expect, it } from "vitest";
import type { CodeToken } from "../lib/highlight";
import { changedRanges, commonIndent, declarationHeader, sliceTokens } from "./declaration";

describe("declarationHeader", () => {
  it("找回被压成一行的多行声明，最后一行在函数体前截断", () => {
    const lines = [
      "export function PseudocodePanel({",
      "  steps,",
      "  fileId,",
      "}: {",
      "  steps: Step[] | null;",
      "  fileId: string;",
      "}) {",
      "  const t = useT();",
    ];
    const signature = "function PseudocodePanel({ steps, fileId, }: { steps: Step[] | null; fileId: string; })";
    expect(declarationHeader(lines, signature)).toEqual({ count: 7, lastColumn: 2 });
  });

  it("单行声明只占一行", () => {
    expect(declarationHeader(["  async load(id: string): Promise<void> {", "    await x;"], "async load(id: string): Promise<void>"))
      .toEqual({ count: 1, lastColumn: 39 });
  });

  it("签名被截断过也能定位到截断处", () => {
    const lines = ["type Long = {", "  alpha: string;", "  beta: number;", "};"];
    expect(declarationHeader(lines, "type Long = { alpha: string; be")).toEqual({ count: 3, lastColumn: 4 });
  });

  it("源码和签名对不上时返回 null", () => {
    expect(declarationHeader(["function other() {}"], "function missing()")).toBeNull();
    expect(declarationHeader(["function a() {}"], "")).toBeNull();
  });
});

describe("changedRanges", () => {
  it("按整词圈出改动", () => {
    expect(changedRanges("function f(a: string)", "function f(a: number)"))
      .toEqual({ before: [[14, 20]], after: [[14, 20]] });
    expect(changedRanges("let fooBar: T", "let fooBaz: T")).toEqual({ before: [[4, 10]], after: [[4, 10]] });
  });

  it("两处分开的插入各圈各的，不把中间没动的也算进去", () => {
    expect(changedRanges("f({ a, }: { a: T; })", "f({ a, b, }: { a: T; b: U; })"))
      .toEqual({ before: [], after: [[7, 9], [21, 26]] });
    expect(changedRanges("same", "same")).toEqual({ before: [], after: [] });
  });
});

describe("sliceTokens", () => {
  it("按列切 token，跨 token 的边界也切开", () => {
    const tokens: CodeToken[] = [["  ", null, 0], ["function", "k", 0], [" foo", "f", 0]];
    expect(sliceTokens(tokens, 2, 12)).toEqual([["function", "k", 0], [" f", "f", 0]]);
  });
});

describe("commonIndent", () => {
  it("忽略空行取最小缩进", () => {
    expect(commonIndent(["    a(", "", "      b,", "    )"])).toBe(4);
    expect(commonIndent([])).toBe(0);
  });
});
