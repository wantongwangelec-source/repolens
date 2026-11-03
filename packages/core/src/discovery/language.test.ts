import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  extractorFamily,
  isAnalyzable,
  languageDefinition,
  registerLanguage,
} from "./language.js";
import { registerLanguagePlugin } from "../language-plugin.js";
import { emptyParsedFile, type LanguageExtractor } from "../parse/extractors/types.js";
import { extractorFor } from "../parse/extractors/registry.js";

describe("语言注册表", () => {
  it.each([
    ["src/App.vue", "vue", true],
    ["src/Widget.svelte", "svelte", true],
    ["src/Page.astro", "astro", true],
    ["src/Main.java", "java", true],
    ["src/lib.cpp", "cpp", true],
    ["src/App.kt", "kotlin", false],
    ["src/query.sql", "sql", false],
    ["src/custom.unknown", "other", false],
  ] as const)("识别 %s 为 %s", (path, language, analyzable) => {
    expect(detectLanguage(path)).toBe(language);
    expect(isAnalyzable(language)).toBe(analyzable);
  });

  it("复合组件统一复用 TS 抽取器与 resolver", () => {
    expect(extractorFamily("vue")).toBe("ts");
    expect(languageDefinition("vue")?.embedded).toBe("vue");
    expect(languageDefinition("vue")?.resolver).toBe("ts");
  });

  it("允许注册带独立 wasm 的命名空间语言", () => {
    const id = `custom:test-${Math.random().toString(36).slice(2)}` as const;
    const extension = `.custom-${Math.random().toString(36).slice(2)}`;
    registerLanguage({
      id, extensions: [extension], grammarPath: "/tmp/tree-sitter-custom.wasm", extractor: "generic",
    });
    expect(detectLanguage(`src/file${extension}`)).toBe(id);
    expect(isAnalyzable(id)).toBe(true);
  });

  it("插件可一次注册语言与专用抽取器", () => {
    const id = `custom:plugin-${Math.random().toString(36).slice(2)}` as const;
    const extension = `.plugin-${Math.random().toString(36).slice(2)}`;
    const extractor: LanguageExtractor = {
      family: "generic",
      extract: () => emptyParsedFile(),
    };
    registerLanguagePlugin({
      definition: { id, extensions: [extension], grammarPath: "/tmp/plugin.wasm" },
      extractor,
    });
    expect(detectLanguage(`src/file${extension}`)).toBe(id);
    expect(extractorFor(id)).toBe(extractor);
  });
});
