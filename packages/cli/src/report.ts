import type { OverviewDto, ScanStats } from "@repolens/core";

const BAR_WIDTH = 24;

export function progressBar(done: number, total: number): string {
  if (total <= 0) return "[" + "─".repeat(BAR_WIDTH) + "]";
  const filled = Math.round((done / total) * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"─".repeat(BAR_WIDTH - filled)}]`;
}

export function formatScanReport(root: string, stats: ScanStats): string {
  const lines: string[] = [];
  lines.push(`已索引 ${root}`);
  lines.push("");
  lines.push(
    row("文件", `${stats.filesDiscovered} 个（解析 ${stats.filesParsed}，复用 ${stats.filesReused}，删除 ${stats.filesDeleted}）`),
  );
  lines.push(row(
    "代码行",
    stats.sourceLoc !== undefined && stats.sourceLoc !== stats.loc
      ? `源码 ${formatNumber(stats.sourceLoc)}（含测试、文档、配置共 ${formatNumber(stats.loc)}）`
      : formatNumber(stats.loc),
  ));
  lines.push(row("符号", `${formatNumber(stats.symbols)}`));
  lines.push(row("包", `${stats.packages}`));
  lines.push(
    row(
      "依赖",
      `${formatNumber(stats.imports)} 条 import：内部 ${formatNumber(stats.importsResolved)}，外部 ${formatNumber(stats.importsExternal)}，未解析 ${formatNumber(stats.importsUnresolved)}${resolutionRate(stats)}`,
    ),
  );
  lines.push(row("调用点", `${formatNumber(stats.calls)}${callBreakdown(stats)}`));
  if (stats.http && stats.http.linked > 0) {
    const { routes, linked, ambiguous } = stats.http;
    lines.push(
      row(
        "HTTP",
        `${linked} 处前端请求按 URL 对上后端路由（共 ${routes} 个路由${ambiguous > 0 ? `，多义 ${ambiguous}` : ""}）`,
      ),
    );
  }
  if (stats.tests && stats.tests.cases > 0) {
    const { cases, covered, functions } = stats.tests;
    const share = functions === 0 ? 0 : Math.round((covered / functions) * 100);
    lines.push(row("测试", `${formatNumber(cases)} 个用例走到 ${formatNumber(covered)} / ${formatNumber(functions)} 个源码函数（${share}%）`));
  }
  if (stats.history) {
    const { commits, files, aiCommits } = stats.history;
    lines.push(row("历史", `近一年 ${formatNumber(commits)} 次提交改过 ${formatNumber(files)} 个文件${aiCommits > 0 ? `，其中 ${formatNumber(aiCommits)} 次标明有 AI 参与` : ""}`));
  }
  if (stats.parseErrors > 0) {
    lines.push(row("语法警告", `${stats.parseErrors} 个文件含无法解析的节点`));
  }
  if (stats.llm) {
    const llm = stats.llm;
    lines.push(
      row(
        "LLM",
        llm.available
          ? `${llm.model} · ${llm.generated} 条生成 · ${llm.cacheHits} 条缓存 · ${formatNumber(llm.totalTokens)} tokens${llm.failures > 0 ? ` · ${llm.failures} 次失败` : ""}`
          : `纯结构模式（${llm.reason ?? "不可用"}）`,
      ),
    );
  }

  const langs = Object.entries(stats.byLanguage)
    .filter(([, v]) => v.loc > 0)
    .sort((a, b) => b[1].loc - a[1].loc)
    .slice(0, 6)
    .map(([lang, v]) => `${lang} ${formatNumber(v.loc)}`)
    .join(" · ");
  if (langs.length > 0) lines.push(row("语言", langs));

  lines.push(row("耗时", `${(stats.durationMs / 1000).toFixed(2)}s`));
  lines.push("");
  lines.push("运行 `repolens serve` 在浏览器中查看，或 `repolens open` 一步到位。");
  lines.push("");
  return lines.join("\n");
}

export function formatOverview(overview: OverviewDto): string {
  const lines: string[] = [];
  lines.push(`${overview.repoName}  ${overview.repoRoot}`);
  lines.push(`扫描于 ${overview.scannedAt}`);
  lines.push("");
  lines.push(row("文件", `${formatNumber(overview.totals.sourceFiles)} 个源码文件（共 ${formatNumber(overview.totals.files)}）`));
  lines.push(row("代码行", `源码 ${formatNumber(overview.totals.sourceLoc)}（含测试、文档、配置共 ${formatNumber(overview.totals.loc)}）`));
  lines.push(row("符号", formatNumber(overview.totals.symbols)));
  lines.push(row("调用点", formatNumber(overview.totals.calls)));
  lines.push(
    row(
      "依赖",
      `${formatNumber(overview.totals.imports)} 条 import：内部 ${formatNumber(
        overview.totals.importsResolved,
      )}，外部 ${formatNumber(overview.totals.importsExternal)}，未解析 ${formatNumber(
        overview.totals.importsUnresolved,
      )}`,
    ),
  );

  if (overview.languages.length > 0) {
    lines.push("");
    lines.push("语言构成");
    for (const lang of overview.languages.slice(0, 8)) {
      const pct = (lang.share * 100).toFixed(1).padStart(5, " ");
      lines.push(`  ${lang.language.padEnd(12, " ")} ${pct}%  ${formatNumber(lang.loc)} 行`);
    }
  }

  if (overview.packages.length > 1) {
    lines.push("");
    lines.push("包");
    for (const pkg of overview.packages.slice(0, 20)) {
      lines.push(`  ${pkg.name.padEnd(28, " ")} ${formatNumber(pkg.loc).padStart(8, " ")} 行  ${pkg.dir}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * The composition of the confidence of the call point.
 *
 * This number is much more useful than the total: by default, only exact and likely are drawn on the call graph.
 * Reporting the composition is the only way to let people know which part of the entire call they are seeing.
 */
function callBreakdown(stats: ScanStats): string {
  const by = stats.callsByConfidence;
  if (!by || stats.calls === 0) return "";
  const certain = (by.exact ?? 0) + (by.likely ?? 0);
  return `（确定 ${formatNumber(by.exact ?? 0)}，可能 ${formatNumber(
    by.likely ?? 0,
  )}，多义 ${formatNumber(by.ambiguous ?? 0)}，外部 ${formatNumber(
    by.external ?? 0,
  )}，未解析 ${formatNumber(by.unresolved ?? 0)}；可画出 ${(
    (certain / stats.calls) *
    100
  ).toFixed(1)}%）`;
}

function resolutionRate(stats: ScanStats): string {
  const internalOrExternal = stats.importsResolved + stats.importsExternal;
  const total = internalOrExternal + stats.importsUnresolved;
  if (total === 0) return "";
  return `，解析率 ${((internalOrExternal / total) * 100).toFixed(1)}%`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(8, " ")} ${value}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
