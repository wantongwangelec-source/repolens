import { describe, expect, it } from "vitest";
import {
  normalizePseudocode,
  normalizePseudocodeSteps,
  normalizeSummary,
  parsePseudocodeSteps,
  parsePseudocodeText,
  pseudocodeStepsToText,
} from "./semantic-format.js";

describe("AI semantic formatting", () => {
  it("把二次转义的换行恢复为真实摘要段落", () => {
    expect(normalizeSummary(
      "用途：解释兼容入口。\\r\\n\\r\\n核心概念：提供者（服务实现）。\\n\\n工作方式：注册并调用提供者。",
      2_000,
    )).toBe(
      "用途：解释兼容入口。\n\n核心概念：\n- 提供者（服务实现）。\n\n工作方式：\n1. 注册并调用提供者。",
    );
  });

  it("给旧缓存中没有标题的首段补上用途标签", () => {
    expect(normalizeSummary(
      "负责加载认证信息。\\n\\n核心概念：令牌（访问凭据）。",
      2_000,
    )).toBe("用途：负责加载认证信息。\n\n核心概念：\n- 令牌（访问凭据）。");
  });

  it("把字符串伪代码统一成编号步骤和缩进子步骤", () => {
    expect(normalizePseudocode(
      "导出兼容入口\\n注册内置提供者\\nstream(model)\\n  查找提供者\\n  返回流式结果",
      8_000,
      24,
    )).toBe(
      "1. 导出兼容入口\n2. 注册内置提供者\n3. stream(model)\n  - 查找提供者\n  - 返回流式结果",
    );
  });

  it("保留多行内容中用于说明代码的单个反斜杠 n", () => {
    expect(normalizePseudocode(
      "读取输入\n  将字符串 \\n 替换为空格",
      8_000,
    )).toContain("字符串 \\n 替换为空格");
  });

  it("把结构化模型响应渲染成固定格式", () => {
    expect(normalizeSummary({
      purpose: "加载用户配置。",
      keyConcepts: ["配置（运行参数）"],
      workflow: ["读取文件", "合并默认值"],
      notes: [],
    }, 2_000)).toBe(
      "用途：加载用户配置。\n\n核心概念：\n- 配置（运行参数）\n\n工作方式：\n1. 读取文件\n2. 合并默认值",
    );
    expect(normalizePseudocode([
      { step: "读取配置", details: ["文件不存在时使用默认值"] },
      { step: "返回结果", details: [] },
    ], 8_000)).toBe(
      "1. 读取配置\n  - 文件不存在时使用默认值\n2. 返回结果",
    );
  });
});

describe("pseudocode source mapping", () => {
  const bounds = { from: 10, to: 30 };

  it("校验行号：交换颠倒区间、收进越界部分、丢弃完全越界的范围", () => {
    expect(normalizePseudocodeSteps([
      { step: "读取配置", lines: [14, 11], details: [{ text: "缺省时回退", lines: "L12-13" }] },
      { step: "越界收拢", lines: [28, 99] },
      { step: "完全越界", lines: [40, 50] },
      { step: "1. 编号前缀会被去掉", lines: [20] },
    ], bounds)).toEqual([
      { text: "读取配置", lines: [11, 14], children: [{ text: "缺省时回退", lines: [12, 13], children: [] }] },
      { text: "越界收拢", lines: [28, 30], children: [] },
      { text: "完全越界", lines: null, children: [] },
      { text: "编号前缀会被去掉", lines: [20, 20], children: [] },
    ]);
  });

  it("父步骤缺行号时用子步骤并集补上，字符串子步骤没有行号", () => {
    const [step] = normalizePseudocodeSteps([
      { step: "处理请求", details: [{ text: "解析", lines: [12, 14] }, { text: "校验", lines: [18, 21] }, "返回"] },
    ], bounds) ?? [];
    expect(step?.lines).toEqual([12, 21]);
    expect(step?.children.map((child) => child.lines)).toEqual([[12, 14], [18, 21], null]);
  });

  it("按总行数截断，文本形式与旧格式一致", () => {
    const steps = normalizePseudocodeSteps([
      { step: "一", details: ["a", "b"] },
      { step: "二", details: ["c"] },
    ], bounds, 4);
    expect(steps && pseudocodeStepsToText(steps)).toBe("1. 一\n  - a\n  - b\n2. 二");
  });

  it("模型只返回字符串时退化为没有行号的步骤", () => {
    expect(normalizePseudocodeSteps("读取\n  解析\n返回", bounds)).toEqual([
      { text: "读取", lines: null, children: [{ text: "解析", lines: null, children: [] }] },
      { text: "返回", lines: null, children: [] },
    ]);
  });

  it("旧缓存文本与 JSON 映射都能读回", () => {
    expect(parsePseudocodeText("1. 读取\n  - 解析\n2. 返回")).toEqual([
      { text: "读取", lines: null, children: [{ text: "解析", lines: null, children: [] }] },
      { text: "返回", lines: null, children: [] },
    ]);
    expect(parsePseudocodeSteps(JSON.stringify([
      { text: "读取", lines: [3, 5], children: [{ text: "解析", lines: [9, 4] }] },
      { lines: [1, 2] },
    ]))).toEqual([
      { text: "读取", lines: [3, 5], children: [{ text: "解析", lines: null, children: [] }] },
    ]);
    expect(parsePseudocodeSteps("not json")).toBeNull();
  });
});
