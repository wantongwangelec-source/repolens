import { afterAll, describe, expect, it } from "vitest";
import type { AnalyzableLanguage } from "../../types.js";
import { ParserPool } from "../parser-pool.js";
import { genericExtractor } from "./generic.js";

const pool = new ParserPool();
afterAll(() => pool.dispose());

describe("通用结构抽取器", () => {
  it("提取 Java 类型、方法、import 和调用归属", async () => {
    const parsed = await parse(
      "java",
      "Demo.java",
      "import java.util.List; class Demo { public void run() { helper(); } }",
    );
    expect(parsed.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Demo", kind: "class" }),
      expect.objectContaining({ name: "run", kind: "method", container: "Demo" }),
    ]));
    expect(parsed.imports).toEqual([expect.objectContaining({ source: "java.util.List" })]);
    expect(parsed.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callerName: "run", callee: "helper" }),
    ]));
  });

  it("提取 Shell 函数、source 依赖和调用", async () => {
    const parsed = await parse("shell", "build.sh", "source ./lib.sh\nrun() { helper; }\nrun\n");
    expect(parsed.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "run", kind: "function" }),
    ]));
    expect(parsed.imports).toEqual([expect.objectContaining({ source: "./lib.sh" })]);
    expect(parsed.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callerName: "run", callee: "helper" }),
      expect.objectContaining({ callerName: null, callee: "run" }),
    ]));
  });

  it("识别 C++ 类体内的 function_definition 为方法", async () => {
    const parsed = await parse(
      "cpp", "demo.cpp", "class Demo { public: void run() { helper(); } };",
    );
    expect(parsed.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Demo", kind: "class" }),
      expect.objectContaining({ name: "run", kind: "method", container: "Demo" }),
    ]));
  });
});

async function parse(language: AnalyzableLanguage, path: string, source: string) {
  const parser = await pool.parserFor(language);
  expect(parser).not.toBeNull();
  const tree = parser!.parse(source)!;
  try {
    return genericExtractor.extract({ root: tree.rootNode, source, language, path });
  } finally {
    tree.delete();
  }
}
