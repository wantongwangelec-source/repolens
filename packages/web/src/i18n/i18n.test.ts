import { afterEach, describe, expect, it } from "vitest";
import { EN } from "./en";
import { t, translateMessage, useLocaleStore } from "./index";

const SOURCES = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.ts", "!./**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Deliberately retain the Chinese parts: the Chinese glyph on the language switch, and internal errors that only go into the log without appearing on the interface */
const ALLOWED: Record<string, readonly string[] | "*"> = {
  "../main.tsx": "*",
  "../graph/layout/engine.ts": "*",
  "../layout/TopBar.tsx": ["中", "切换到中文", "界面语言"],
  // Except for the first item, all come from the regular expressions output by the parsing model
  "../graph/HoverCard.tsx": ["语义结果不完整", "用途", "：", "。！？"],
};

const LITERAL = /\b(?:t|msg)\("((?:[^"\\]|\\.)*)"/g;
const CJK = /[\u3400-\u9fff\uff01-\uff5e\u3000-\u303f]+/g;

function keysIn(source: string): string[] {
  return [...source.matchAll(LITERAL)].map((match) => JSON.parse(`"${match[1]}"`) as string);
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))].sort();
}

/** After removing the comments and the copy that has already gone through t()/msg(), the remaining Chinese is the untranslated text. */
function untranslated(source: string): string[] {
  const code = source
    .replace(LITERAL, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...new Set(code.match(CJK) ?? [])];
}

afterEach(() => {
  useLocaleStore.setState({ locale: "zh" });
});

describe("界面文案", () => {
  const files = Object.entries(SOURCES);

  it("能读到源码", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("每条 t()/msg() 文案都有英文，占位符一一对应", () => {
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const [file, source] of files) {
      for (const key of keysIn(source)) {
        const entry = EN[key];
        if (entry === undefined) {
          missing.push(`${file}: ${key}`);
          continue;
        }
        const expected = placeholders(key);
        if (typeof entry === "string") {
          if (placeholders(entry).join() !== expected.join()) mismatched.push(key);
        } else {
          const output = entry(Object.fromEntries(expected.map((name) => [name, `<${name}>`])));
          if (expected.some((name) => !output.includes(`<${name}>`)) || /[{}]/.test(output)) mismatched.push(key);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(mismatched).toEqual([]);
  });

  it("界面代码里没有绕过 t() 的中文", () => {
    const leaks: string[] = [];
    for (const [file, source] of files) {
      const allowed = ALLOWED[file];
      if (allowed === "*") continue;
      for (const text of untranslated(source)) {
        if (!allowed?.includes(text)) leaks.push(`${file}: ${text}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("英文词条都是纯英文", () => {
    const leftovers = Object.entries(EN)
      .map(([key, entry]) => [key, typeof entry === "string" ? entry : entry({ count: 2 })] as const)
      .filter(([, text]) => /[\u3400-\u9fff]/.test(text))
      .map(([key]) => key);
    expect(leftovers).toEqual([]);
  });
});

describe("t", () => {
  it("中文界面原样显示并替换占位符", () => {
    expect(t("正在扫描 {name}", { name: "micrograd" })).toBe("正在扫描 micrograd");
  });

  it("英文界面按数量选单复数，查不到的原样显示", () => {
    useLocaleStore.setState({ locale: "en" });
    expect(t("{count} 个文件", { count: 1 })).toBe("1 file");
    expect(t("{count} 个文件", { count: "1,024" })).toBe("1,024 files");
    expect(t("正在扫描 {name}", { name: "micrograd" })).toBe("Scanning micrograd");
    expect(t("词典里没有的一句")).toBe("词典里没有的一句");
    expect(t("constructor")).toBe("constructor");
  });
});

describe("translateMessage", () => {
  it("只在英文界面翻译，整句优先，带路径的按模式", () => {
    expect(translateMessage("文件不存在")).toBe("文件不存在");
    useLocaleStore.setState({ locale: "en" });
    expect(translateMessage("文件不存在")).toBe("File not found");
    expect(translateMessage("仓库目录不存在：/tmp/repo")).toBe("Repository folder not found: /tmp/repo");
    expect(translateMessage("未设置环境变量 OPENAI_API_KEY")).toBe("The OPENAI_API_KEY environment variable isn't set");
    expect(translateMessage("toString")).toBe("toString");
    expect(translateMessage("upstream 502")).toBe("upstream 502");
  });
});
