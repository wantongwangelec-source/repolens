import type { GraphNodeDto, IoKind, Language, SymbolKind } from "@repolens/core/types";
import { msg, t } from "../i18n";
import type { MetricKey } from "../store/useAppStore";

/** The value must pass through t() during rendering */
export const IO_LABELS: Record<IoKind, string> = {
  database: msg("数据库"),
  network: msg("网络"),
  filesystem: msg("文件系统"),
  "message-queue": msg("消息队列"),
  process: msg("子进程"),
};

const LANGUAGE_COLORS: Record<string, string> = {
  typescript: "var(--lang-typescript)",
  tsx: "var(--lang-tsx)",
  javascript: "var(--lang-javascript)",
  jsx: "var(--lang-jsx)",
  python: "var(--lang-python)",
  go: "var(--lang-go)",
  rust: "var(--lang-rust)",
  vue: "var(--lang-vue)",
  svelte: "var(--lang-svelte)",
  astro: "var(--lang-astro)",
  java: "var(--lang-java)",
  c: "var(--lang-cpp)",
  cpp: "var(--lang-cpp)",
  csharp: "var(--lang-csharp)",
  php: "var(--lang-php)",
  ruby: "var(--lang-ruby)",
  shell: "var(--lang-shell)",
  powershell: "var(--lang-shell)",
};

const NEUTRAL = "var(--lang-other)";

export function languageColor(language: Language | null | undefined): string {
  if (!language) return NEUTRAL;
  return LANGUAGE_COLORS[language] ?? NEUTRAL;
}

export function nodeAccent(node: GraphNodeDto): string {
  // Dots, color bars, and tooltip markers only represent programming languages across the entire site. The architecture layer is model inference,
  // Continue to present using text labels, without covering the language color, otherwise the same blue would represent both.
  // TypeScript and a certain AI architecture layer.
  if (node.kind === "external") return "var(--color-ink-faint)";
  if (node.kind === "aggregate") return "var(--color-ink-faint)";
  if (node.language) return languageColor(node.language);
  return "var(--color-ink-muted)";
}

/** The value must pass through t() during rendering */
export const METRIC_LABELS: Record<MetricKey, string> = {
  loc: msg("代码行"),
  complexity: msg("复杂度"),
  symbols: msg("符号数"),
};

export function metricValue(node: GraphNodeDto, metric: MetricKey): number {
  switch (metric) {
    case "loc":
      return node.metrics.loc;
    case "complexity":
      return node.metrics.complexity;
    case "symbols":
      return node.metrics.symbols;
  }
}

/**
 * Node size is scaled according to the main metrics.
 *
 * Use the square root instead of linear mapping: the distribution of lines of code in a repository usually spans two orders of magnitude,
 * The linear mapping will let the largest node consume the entire canvas.
 */
export function nodeSize(
  node: GraphNodeDto,
  metric: MetricKey,
  maxMetric: number,
): { width: number; height: number } {
  if (node.kind === "external") return { width: 150, height: 46 };

  const raw = metricValue(node, metric);
  const scale = maxMetric > 0 ? Math.sqrt(Math.max(0, raw) / maxMetric) : 0;
  const metricWidth = 152 + 84 * scale;
  const metadata = [
    formatCount(raw),
    node.layer ? `· ${node.layer}` : null,
    node.childCount > 0 && node.kind !== "symbol" ? t("· {count} 项", { count: node.childCount }) : null,
    node.metrics.inDegree + node.metrics.outDegree > 0
      ? `↓${node.metrics.outDegree} ↑${node.metrics.inDegree}`
      : null,
  ].filter((part): part is string => part !== null);

  // Line two is not allowed to break, and the architecture layer cannot be truncated to 'Tools and Config...'. Originally, the node was only according to
  // The indicators determine the width, and small nodes cannot accommodate long layer names + the number of sub-items. Here it is estimated according to the actual text.
  // A lower limit for content; the indicators can still highlight important nodes, but they will no longer compress metadata.
  const metadataWidth = metadata.reduce((sum, part) => sum + estimateLabelWidth(part), 0)
    + Math.max(0, metadata.length - 1) * 8
    + 28;
  return {
    width: Math.round(Math.max(metricWidth, metadataWidth)),
    height: Math.round(50 + 24 * scale),
  };
}

/** Based on a conservative estimate of 130% of the maximum font size, switching the font size will not cause clipping to occur again. */
function estimateLabelWidth(value: string): number {
  let width = 0;
  for (const char of value) width += char.charCodeAt(0) > 0x7f ? 14 : 8;
  return width;
}

/**
 * Display name of the computing node: If the package name, after removing `@scope/`, does not duplicate any other node, then remove it.
 *
 * `@earendil-works/pi-ai` and `@earendil-works/pi-tui` will both be on the node
 * Truncated to `@earendil-works/pi-…`, the prefix takes up the entire width but carries no distinguishing information.
 * The node width is determined by the main metric encoding, and it cannot be widened just to fit the prefix, so the prefix can only be removed.
 * The full name is still retained in the hover card and the details drawer.
 *
 * When removing the prefix would collide with another node, the scope is the only distinguishing information, so this one is kept as is;
 * For packages with the same original name (each directory has a package.json with the same name), add the directory as well.
 */
export function displayLabels(nodes: readonly GraphNodeDto[]): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== "package" || !node.label.startsWith("@")) continue;
    const slash = node.label.indexOf("/");
    if (slash > 0 && slash < node.label.length - 1) stripped.set(node.id, node.label.slice(slash + 1));
  }

  const taken = new Map<string, number>();
  const bump = (label: string) => taken.set(label, (taken.get(label) ?? 0) + 1);
  for (const node of nodes) bump(stripped.get(node.id) ?? node.label);
  for (const node of nodes) {
    const short = stripped.get(node.id);
    out.set(node.id, short !== undefined && taken.get(short) === 1 ? short : node.label);
  }

  const shown = new Map<string, number>();
  for (const label of out.values()) shown.set(label, (shown.get(label) ?? 0) + 1);
  for (const node of nodes) {
    const label = out.get(node.id) as string;
    if (node.kind === "package" && (shown.get(label) ?? 0) > 1 && node.path) out.set(node.id, `${label} (${node.path})`);
  }
  return out;
}

export function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

const SYMBOL_GLYPHS: Partial<Record<SymbolKind, string>> = {
  function: "ƒ",
  method: "ƒ",
  class: "C",
  interface: "I",
  struct: "S",
  trait: "T",
  enum: "E",
  type: "T",
  impl: "◆",
  constant: "K",
  variable: "V",
  module: "M",
  property: "P",
};

export function symbolGlyph(kind: SymbolKind | null | undefined): string {
  if (!kind) return "·";
  return SYMBOL_GLYPHS[kind] ?? "·";
}

export function kindLabel(node: GraphNodeDto): string {
  switch (node.kind) {
    case "package":
      return t("包");
    case "directory":
      return t("目录");
    case "file":
      return t("文件");
    case "symbol":
      return node.symbolKind ?? t("符号");
    case "external":
      return t("外部依赖");
    case "aggregate":
      return t("折叠组");
  }
}
