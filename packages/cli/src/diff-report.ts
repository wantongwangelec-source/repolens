import type { BehaviorChangeDto, ChangeClusterDto, ChangeReportDto, ClusterReason, SymbolChangeDto } from "@repolens/core";
import { IO_NAMES } from "./labels.js";

const LIMIT = 30;
const MARK = { added: "+", removed: "-", modified: "~", moved: ">", affected: "~", resolved: "✓" } as const;
const REASON_NAMES: Record<ClusterReason, string> = {
  exported: "对外接口", signature: "签名变化", io: "新 I/O", calls: "新调用", complexity: "复杂度上升", untested: "没有测试", entries: "入口",
};

/**
 * The change report is sorted according to 'what to look at first during review': new dependencies at the structural level, external interfaces, and entry impacts come first.
 * The symbol list for each file is at the end. Plain text with Markdown headers can be read in the terminal and directly pasted into the PR description.
 */
export function formatChangeReport(report: ChangeReportDto): string {
  const lines: string[] = [];
  const head = report.head ? `${report.head.ref} (${report.head.commit.slice(0, 8)})` : "工作区";
  lines.push(`结构变更  ${report.base.ref} (${report.base.commit.slice(0, 8)}) → ${head}`);
  lines.push("");

  const files = count(report.files.map((f) => f.status));
  const sourceFiles = report.files.filter((f) => f.role === "source").length;
  const symbols = report.symbols.filter((s) => s.role !== "test");
  const bySymbol = count(symbols.map((s) => s.status));
  const exported = symbols.filter((s) => s.exported).length;
  const deps = report.dependencies;
  const entries = count(report.entries.map((e) => e.status));
  const findings = count(report.findings.map((f) => f.status));
  lines.push(row("文件", `修改 ${files.modified ?? 0} · 新增 ${files.added ?? 0} · 删除 ${files.removed ?? 0} · 移动 ${files.moved ?? 0}（源码 ${sourceFiles}）`));
  lines.push(row("符号", `新增 ${bySymbol.added ?? 0} · 修改 ${bySymbol.modified ?? 0} · 删除 ${bySymbol.removed ?? 0}（对外导出 ${exported}，不含测试）`));
  lines.push(row("依赖", `包级 ${delta(deps.filter((d) => d.level === "package"))} · 目录级 ${delta(deps.filter((d) => d.level === "directory"))}`));
  lines.push(row("外部库", [...report.externals.added.map((n) => `+${n}`), ...report.externals.removed.map((n) => `-${n}`)].join(" ") || "无变化"));
  lines.push(row("体检", `新增 ${findings.added ?? 0} · 消除 ${findings.resolved ?? 0}`));
  lines.push(row("入口", `新增 ${entries.added ?? 0} · 删除 ${entries.removed ?? 0} · 受影响 ${entries.affected ?? 0}`));
  const ioEntries = report.entries.filter((e) => (e.ioAdded?.length ?? 0) > 0);
  if (ioEntries.length > 0) lines.push(row("I/O", `${ioEntries.length} 个入口往下新碰到了 I/O`));

  if (report.files.length === 0) {
    lines.push("", "没有结构变化。", "");
    return lines.join("\n");
  }

  section(lines, "模块依赖变化", deps.map((d) =>
    `${MARK[d.status]} ${d.level === "package" ? "[包] " : ""}${d.source} → ${d.target}${d.type === "references" ? "（仅类型）" : d.type === "http" ? "（HTTP 请求）" : ""}  ${d.count} 处`));

  section(lines, "外部库变化", [
    ...report.externals.added.map((name) => `+ ${name}`),
    ...report.externals.removed.map((name) => `- ${name}`),
  ]);

  section(lines, "改动单元（按调用关系归组，风险高的在前）", report.clusters.slice(0, 12).map(describeCluster));

  section(lines, "行为变化（新调了谁、开始碰哪类 I/O）", report.behavior.map(describeBehavior));

  section(lines, "对外接口变化（导出符号）", symbols.filter((s) => s.exported).map(describeSymbol));

  section(lines, "入口", report.entries.map((e) => {
    const shown = e.via.slice(0, 4).map((v) => (v.depth === 0 ? `${v.name}（入口本身）` : `${v.name}（第 ${v.depth} 跳）`));
    const via = shown.join("、") + (e.via.length > shown.length ? ` 等 ${e.via.length} 处` : "");
    const io = [
      ...(e.ioAdded ?? []).map((kind) => `+${IO_NAMES[kind]}`),
      ...(e.ioRemoved ?? []).map((kind) => `-${IO_NAMES[kind]}`),
    ].join(" ");
    return `${MARK[e.status]} ${e.label.padEnd(28, " ")} ${e.status === "affected" ? `走到 ${via}` : e.path}${io ? `  I/O ${io}` : ""}`;
  }));

  const untested = symbols.filter((s) => s.status !== "removed" && s.tests === 0 && s.shapeChanged && (s.kind === "function" || s.kind === "method"));
  section(lines, "改了但没有任何测试走到", untested.map((s) => `${s.path}:${s.line}  ${qualified(s)}`));

  section(lines, "体检", report.findings.map((f) =>
    `${f.status === "added" ? "+ 新增" : "✓ 消除"} [${f.severity}] ${f.title}`));

  const complexer = symbols
    .filter((s) => s.status !== "removed" && s.complexity - (s.complexityBefore ?? 0) >= 5)
    .sort((a, b) => b.complexity - (b.complexityBefore ?? 0) - (a.complexity - (a.complexityBefore ?? 0)));
  section(lines, "复杂度上升", complexer.map((s) =>
    `${s.path}:${s.line}  ${qualified(s)}  ${s.complexityBefore ?? 0} → ${s.complexity}`));

  const byFile = new Map<string, SymbolChangeDto[]>();
  for (const s of report.symbols) {
    const bucket = byFile.get(s.path);
    if (bucket) bucket.push(s); else byFile.set(s.path, [s]);
  }
  const fileLines: string[] = [];
  for (const file of report.files) {
    const note = file.status === "moved" ? `（从 ${file.from}）` : file.role !== "source" ? `（${file.role}）` : "";
    fileLines.push(`${MARK[file.status]} ${file.path}${note}  ${file.locBefore} → ${file.loc} 行`);
    // When the entire file is added or deleted, the internal functions of each column have no information, only the exported ones are listed.
    const changes = byFile.get(file.path) ?? [];
    const whole = file.status === "added" || file.status === "removed";
    const listed = whole ? changes.filter((s) => s.exported) : changes;
    for (const s of listed) {
      const cosmetic = s.status === "modified" && !s.shapeChanged ? "（仅命名/字面量/格式）" : "";
      fileLines.push(`    ${MARK[s.status]} ${qualified(s)}${cosmetic}`);
    }
    if (listed.length < changes.length) fileLines.push(`    …及 ${changes.length - listed.length} 个内部符号`);
  }
  section(lines, "逐文件", fileLines, LIMIT * 4);

  lines.push("");
  return lines.join("\n");
}

function describeSymbol(s: SymbolChangeDto): string {
  const where = `${s.path}:${s.line}`;
  if (s.status === "removed") return `- ${where}  ${qualified(s)}（基线里有 ${s.callers} 个调用方）`;
  if (s.status === "added") return `+ ${where}  ${s.signature ?? qualified(s)}`;
  const signature = s.signatureBefore !== s.signature ? `\n      签名：${s.signatureBefore} → ${s.signature}` : "";
  return `~ ${where}  ${qualified(s)}（${s.callers} 个调用方）${signature}`;
}

function qualified(s: SymbolChangeDto): string {
  return s.container ? `${s.container}.${s.name}` : s.name;
}

function describeCluster(cluster: ChangeClusterDto): string {
  const reasons = cluster.reasons.map((r) => `${REASON_NAMES[r.kind]}${r.count > 1 ? ` ×${r.count}` : ""}`).join("、");
  return `${cluster.label}${cluster.members.length > 1 ? ` 等 ${cluster.members.length} 处` : ""}  风险 ${cluster.risk}${reasons ? `（${reasons}）` : ""}`;
}

function describeBehavior(change: BehaviorChangeDto): string {
  const parts = [
    ...change.ioAdded.map((kind) => `开始访问${IO_NAMES[kind]}`),
    ...change.ioRemoved.map((kind) => `不再访问${IO_NAMES[kind]}`),
    change.callsAdded.length > 0 ? `新调 ${change.callsAdded.map(callName).join("、")}` : "",
    change.callsRemoved.length > 0 ? `不再调 ${change.callsRemoved.map(callName).join("、")}` : "",
  ].filter(Boolean);
  return `${change.status === "added" ? "+" : "~"} ${change.path}:${change.line}  ${change.name}：${parts.join("；")}`;
}

function callName(call: BehaviorChangeDto["callsAdded"][number]): string {
  return call.external ? `${call.external}.${call.name}` : call.name;
}

function section(lines: string[], title: string, items: string[], limit = LIMIT): void {
  if (items.length === 0) return;
  lines.push("", `## ${title}`);
  for (const item of items.slice(0, limit)) lines.push(`  ${item}`);
  if (items.length > limit) lines.push(`  …还有 ${items.length - limit} 项（--json 查看全部）`);
}

function count(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function delta(items: ChangeReportDto["dependencies"]): string {
  return `+${items.filter((d) => d.status === "added").length}/-${items.filter((d) => d.status === "removed").length}`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(6, " ")} ${value}`;
}
