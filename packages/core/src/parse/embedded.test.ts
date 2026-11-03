import { afterAll, describe, expect, it } from "vitest";
import { extractorFor } from "./extractors/registry.js";
import { prepareSource } from "./embedded.js";
import { ParserPool } from "./parser-pool.js";

const pool = new ParserPool();
afterAll(() => pool.dispose());

describe("复合组件源码", () => {
  it("Vue 保留多个 script 和原文件 UTF-8 字节位置", async () => {
    const source = [
      "<template>",
      "  <p>你好</p>",
      "</template>",
      "<script>",
      'import helper from "./helper"',
      "export default {",
      "  methods: {",
      "    load() { helper() }",
      "  }",
      "}",
      "</script>",
      '<script setup lang="ts">',
      "const reset = () => helper()",
      "</script>",
      "<style>.x { color: red }</style>",
      "",
    ].join("\n");
    const prepared = prepareSource("vue", source);
    expect(prepared).not.toBeNull();
    expect(prepared?.parserLanguage).toBe("typescript");
    expect(Buffer.byteLength(prepared!.source)).toBe(Buffer.byteLength(source));
    expect(lineBreaks(prepared!.source)).toEqual(lineBreaks(source));
    expect(prepared!.source).not.toContain("你好");

    const parser = await pool.parserFor(prepared!.parserLanguage);
    const tree = parser!.parse(prepared!.source)!;
    try {
      const parsed = extractorFor(prepared!.parserLanguage).extract({
        root: tree.rootNode, source: prepared!.source, language: prepared!.parserLanguage, path: "App.vue",
      });
      expect(parsed.imports).toEqual(expect.arrayContaining([expect.objectContaining({ source: "./helper", line: 5 })]));
      expect(parsed.symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "load", startLine: 8 }),
        expect.objectContaining({ name: "reset", startLine: 13 }),
      ]));
      expect(parsed.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ callerName: "load", callee: "helper", line: 8 }),
        expect.objectContaining({ callerName: "reset", callee: "helper", line: 13 }),
      ]));
    } finally {
      tree.delete();
    }
  });

  it("Svelte script 使用同一映射机制", () => {
    const source = '<h1>标题</h1>\n<script>\nexport function open() { return run() }\n</script>\n';
    const prepared = prepareSource("svelte", source)!;
    expect(prepared.parserLanguage).toBe("javascript");
    expect(Buffer.byteLength(prepared.source)).toBe(Buffer.byteLength(source));
    expect(prepared.source).toContain("export function open");
    expect(prepared.source).not.toContain("标题");
  });

  it("Astro 只保留顶部 frontmatter", () => {
    const source = '---\nimport Card from "./Card.astro"\nconst title: string = "首页"\n---\n<Card>{title}</Card>\n';
    const prepared = prepareSource("astro", source)!;
    expect(prepared.parserLanguage).toBe("typescript");
    expect(Buffer.byteLength(prepared.source)).toBe(Buffer.byteLength(source));
    expect(prepared.source).toContain("import Card");
    expect(prepared.source).not.toContain("<Card>");
  });
});

function lineBreaks(source: string): number[] {
  const out: number[] = [];
  const bytes = Buffer.from(source);
  bytes.forEach((byte, index) => { if (byte === 0x0a || byte === 0x0d) out.push(index); });
  return out;
}
