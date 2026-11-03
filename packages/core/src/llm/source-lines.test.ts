import { describe, expect, it } from "vitest";
import { hasElidedLines, numberSourceLines } from "./source-lines.js";

describe("numberSourceLines", () => {
  it("给源码加绝对行号并在整行处截断", () => {
    expect(numberSourceLines("a\nb\nc\n", 41, 1_000)).toBe("41| a\n42| b\n43| c");
    expect(numberSourceLines("aaaa\nbbbb\ncccc", 1, 16)).toBe("1| aaaa\n2| bbbb");
  });

  it("超长的行只留开头，行号不变，后面的源码不会被它挤掉", () => {
    const image = `"image/png": "${"A".repeat(24_000)}"`;
    const numbered = numberSourceLines(`before\n${image}\nafter`, 58, 1_000);
    const lines = numbered.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`59| ${image.slice(0, 120)}…（省略 ${image.length - 120} 字符）`);
    expect(lines[2]).toBe("60| after");
    expect(hasElidedLines(numbered)).toBe(true);
    expect(hasElidedLines(numberSourceLines("x".repeat(400), 1, 1_000))).toBe(false);
  });
});
