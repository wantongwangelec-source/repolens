import { LOCK_FILENAME, type ArchitectureLock, type CheckReport, type LockedDependency, type RuleReport } from "@repolens/core";

const LIMIT = 20;

const RULES_HINT = `没有声明依赖规则。在仓库根目录的 .repolens.json 里加上 rules，例如：

  {
    "rules": [
      {
        "name": "前端不直接依赖服务端",
        "from": "packages/web/**",
        "disallow": ["packages/server/**", "better-sqlite3"],
        "reason": "前端只经 HTTP API 访问服务端"
      }
    ]
  }

disallow 可以写仓库内路径 glob，也可以写外部包名；allow 列例外；纯类型 import 默认放行，
需要一并禁止时加 "includeTypeOnly": true。
`;

export const NOTHING_TO_CHECK = `没有可检查的约定。三种约定可以任选：

  1. 依赖规则：.repolens.json 的 rules，写明哪些模块不许依赖哪些
  2. 依赖锁：运行 repolens lock，把现在的模块间依赖记成批准过的清单，之后新长出来的依赖都要先批准
  3. 棘轮：repolens check --baseline main，相对基线不许新增模块环、规则违规、分层倒置等问题

规则和棘轮写在 .repolens.json，依赖锁写在 .repolens.lock.json，两份都随代码提交，CI 和每个人读到的是同一份；
个人偏好放 .repolens.local.json，不提交。

${RULES_HINT}`;

export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(report.passed ? "约定检查：通过" : "约定检查：未通过", "");
  if (report.rules.length > 0) lines.push(formatRuleReports(report.rules));
  if (report.lock) {
    lines.push(report.unapproved.length === 0
      ? `依赖锁  ${report.lock.dependencies} 条批准过的${report.lock.level === "package" ? "包" : "模块"}间依赖 · 没有新依赖`
      : `依赖锁  ${report.unapproved.length} 条依赖不在锁里（.repolens.lock.json）`);
    for (const dep of report.unapproved.slice(0, LIMIT)) {
      lines.push(`  ✗ ${dep.from} → ${dep.to}${dep.type === "http" ? "（HTTP 请求）" : ""}  ${dep.count} 处`);
      for (const sample of dep.samples) lines.push(`      ${sample}`);
    }
    if (report.unapproved.length > 0) lines.push("    确认合理后运行 repolens lock 更新锁文件，让这次批准出现在代码评审里。");
    lines.push("");
  }
  if (report.ratchet) {
    const { base, failed, warned } = report.ratchet;
    lines.push(`棘轮  对比 ${base.ref} (${base.commit.slice(0, 8)})：${failed.length === 0 ? "没有新增被拦下的问题" : `新增 ${failed.length} 处被拦下的问题`}`);
    for (const finding of failed.slice(0, LIMIT)) lines.push(`  ✗ [${finding.kind}] ${finding.title}  ${finding.path}`);
    if (warned.length > 0) {
      lines.push(`  另有 ${warned.length} 处新增问题只提示、不拦：`);
      for (const finding of warned.slice(0, LIMIT)) lines.push(`  ! [${finding.kind}] ${finding.title}  ${finding.path}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatLockReport(previous: ArchitectureLock | null, lock: ArchitectureLock): string {
  const key = (dep: LockedDependency) => `${dep.from}\u0000${dep.to}\u0000${dep.type}`;
  const before = new Set((previous?.level === lock.level ? previous.dependencies : []).map(key));
  const after = new Set(lock.dependencies.map(key));
  const added = previous?.level === lock.level ? lock.dependencies.filter((dep) => !before.has(key(dep))) : [];
  const removed = previous?.level === lock.level ? previous.dependencies.filter((dep) => !after.has(key(dep))) : [];
  const describe = (dep: LockedDependency) => `${dep.from} → ${dep.to}${dep.type === "http" ? "（HTTP 请求）" : ""}`;

  const unit = lock.level === "package" ? "包" : "模块";
  const lines = [`已写入 ${LOCK_FILENAME}：${lock.dependencies.length} 条${unit}间依赖`];
  if (lock.level === "directory") lines.push(`  模块：${lock.modules.join("、") || "（没有找到可以当模块的目录）"}`);
  if (previous && previous.level !== lock.level) {
    lines.push(`  锁的层级从${previous.level === "package" ? "包" : "目录"}换成了${unit}，整份重写`);
  } else if (previous) {
    if (added.length === 0 && removed.length === 0) lines.push("  和原来的锁一样，没有新批准的依赖");
    for (const dep of added) lines.push(`  + ${describe(dep)}`);
    for (const dep of removed) lines.push(`  - ${describe(dep)}（代码里已经没有了）`);
  } else {
    for (const dep of lock.dependencies) lines.push(`  ${describe(dep)}`);
  }
  lines.push("", "提交这个文件：以后新长出来的模块间依赖会被 repolens check 拦下，批准它就得重新运行 repolens lock，批准本身出现在代码评审里。", "");
  return lines.join("\n");
}

function formatRuleReports(reports: readonly RuleReport[]): string {
  const violated = reports.filter((report) => report.violations.length > 0);
  const empty = reports.filter((report) => report.checkedFiles === 0);
  const total = violated.reduce((sum, report) => sum + report.violations.length, 0);

  const lines: string[] = [];
  const verdict = violated.length === 0 && empty.length === 0
    ? "全部通过"
    : [violated.length > 0 ? `${violated.length} 条有违规（共 ${total} 处）` : "", empty.length > 0 ? `${empty.length} 条没有覆盖任何文件` : ""]
      .filter(Boolean)
      .join("，");
  lines.push(`依赖规则  ${reports.length} 条 · ${verdict}`, "");

  for (const report of reports) {
    if (report.checkedFiles === 0) {
      lines.push(`  ! ${report.label}`);
      lines.push("      from 没有匹配任何源码文件，检查路径写法（相对仓库根目录）");
      continue;
    }
    const mark = report.violations.length > 0 ? "✗" : "✓";
    lines.push(`  ${mark} ${report.label}  检查 ${report.checkedFiles} 个文件${report.violations.length > 0 ? `，${report.violations.length} 处越界` : ""}`);
    if (report.violations.length === 0) continue;
    if (report.rule.reason) lines.push(`      ${report.rule.reason}`);
    for (const violation of report.violations.slice(0, LIMIT)) {
      lines.push(`      ${violation.filePath}:${violation.line} → ${violation.target}${violation.typeOnly ? "（仅类型）" : ""}`);
    }
    if (report.violations.length > LIMIT) lines.push(`      … 另有 ${report.violations.length - LIMIT} 处`);
  }
  lines.push("");
  return lines.join("\n");
}
