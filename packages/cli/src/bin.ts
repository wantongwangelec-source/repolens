#!/usr/bin/env node
import {
  BaselineError,
  buildChangeReport,
  buildLock,
  indexPath,
  isIndexCurrent,
  loadConfig,
  loadLock,
  openDb,
  getOverview,
  refreshConventions,
  rememberRepo,
  runCheck,
  scanRepo,
  writeLock,
  type ArchitectureLock,
  type RepolensConfig,
  type ScanPhase,
} from "@repolens/core";
import { DEFAULT_PORT, startServer } from "@repolens/server";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import open from "open";
import { formatCheckReport, formatLockReport, NOTHING_TO_CHECK } from "./check-report.js";
import { formatChangeReport } from "./diff-report.js";
import { serveMcp } from "./mcp.js";
import { formatOverview, formatScanReport, progressBar } from "./report.js";
import { locateWebDist, webAssetsHint } from "./web-assets.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("repolens")
  .description("本地代码仓库理解工具：扫描仓库并在浏览器里可视化架构、结构与调用关系")
  .version(version);

program
  .command("scan", { isDefault: false })
  .description("扫描仓库并写入 .repolens/index.db")
  .argument("[path]", "仓库路径", ".")
  .option("-f, --fresh", "忽略已有索引，全量重建", false)
  .option("-s, --structure-only", "只建结构，不调用模型生成摘要（已有的摘要保留）", false)
  .option("-q, --quiet", "只输出最终结果", false)
  .action(async (path: string, opts: { fresh: boolean; structureOnly: boolean; quiet: boolean }) => {
    const root = resolve(path);
    assertDirectory(root);

    const stats = await scanRepo({
      root,
      fresh: opts.fresh,
      structureOnly: opts.structureOnly,
      history: true,
      onProgress: opts.quiet ? undefined : reportProgress,
    });

    if (!opts.quiet) process.stderr.write("\n");
    process.stdout.write(formatScanReport(root, stats));
    remember(root);
  });

program
  .command("serve")
  .description("启动本地服务浏览已有索引")
  .argument("[path]", "仓库路径", ".")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .option("--host <host>", "监听地址", "127.0.0.1")
  .option("--open", "启动后打开浏览器", false)
  .option("-w, --watch", "盯着文件变化，改动后自动刷新结构并推给界面", false)
  .action(async (path: string, opts: { port: string; host: string; open: boolean; watch: boolean }) => {
    const root = resolve(path);
    remember(root);
    const webRoot = locateWebDist();
    if (webRoot === null) process.stderr.write(`${webAssetsHint()}\n`);

    const server = await startServer({
      repoRoot: root,
      port: Number.parseInt(opts.port, 10),
      host: opts.host,
      webRoot: webRoot ?? undefined,
      watch: opts.watch,
    });
    process.stdout.write(`RepoLens 已启动：${server.url}${opts.watch ? "（盯着文件变化）" : ""}\n按 Ctrl+C 停止\n`);
    if (opts.open) await open(server.url);

    const shutdown = () => {
      void server.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("open")
  .description("扫描（必要时）后启动服务并打开浏览器")
  .argument("[path]", "仓库路径", ".")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .option("-f, --fresh", "强制全量重扫", false)
  .option("-w, --watch", "盯着文件变化，改动后自动刷新结构并推给界面", false)
  .action(async (path: string, opts: { port: string; fresh: boolean; watch: boolean }) => {
    const root = resolve(path);
    assertDirectory(root);

    const needsScan = opts.fresh || !isIndexCurrent(indexPath(root));
    if (needsScan) {
      const stats = await scanRepo({ root, fresh: opts.fresh, onProgress: reportProgress });
      process.stderr.write("\n");
      process.stdout.write(formatScanReport(root, stats));
    }
    remember(root);

    const webRoot = locateWebDist();
    if (webRoot === null) process.stderr.write(`${webAssetsHint()}\n`);

    const server = await startServer({
      repoRoot: root,
      port: Number.parseInt(opts.port, 10),
      webRoot: webRoot ?? undefined,
      watch: opts.watch,
    });
    process.stdout.write(`\nRepoLens 已启动：${server.url}${opts.watch ? "（盯着文件变化）" : ""}\n按 Ctrl+C 停止\n`);
    await open(server.url);

    const shutdown = () => {
      void server.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("info")
  .description("打印已有索引的摘要")
  .argument("[path]", "仓库路径", ".")
  .action((path: string) => {
    const root = resolve(path);
    const dbPath = indexPath(root);
    if (!existsSync(dbPath)) {
      process.stderr.write(`索引不存在：${dbPath}\n先运行 \`repolens scan ${path}\`\n`);
      process.exit(1);
    }
    const db = openDb(dbPath, { readonly: true });
    process.stdout.write(formatOverview(getOverview(db)));
    db.close();
  });

program
  .command("diff")
  .description("对比基线提交与当前代码的结构差异：依赖、对外接口、入口影响面、体检")
  .argument("[path]", "仓库路径", ".")
  .option("-b, --base <ref>", "基线提交：分支、tag、HEAD~n 或 sha", "HEAD")
  .option("--head <ref>", "对比到另一个提交；缺省为工作区（含未提交改动）")
  .option("--json", "输出完整 JSON", false)
  .action(async (path: string, opts: { base: string; head?: string; json: boolean }) => {
    const root = resolve(path);
    assertDirectory(root);
    const progress = opts.json ? undefined : reportProgress;
    try {
      // Only refresh the structure, do not spend tokens during comparison; the existing semantic cache is retained as usual.
      if (!opts.head) await scanRepo({ root, structureOnly: true, onProgress: progress });
      const report = await buildChangeReport(root, { base: opts.base, head: opts.head, onProgress: progress });
      if (progress) process.stderr.write("\n");
      process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatChangeReport(report));
    } catch (err) {
      if (!(err instanceof BaselineError)) throw err;
      process.stderr.write(`\n${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command("check")
  .description("检查约定：依赖规则、依赖锁，给了基线时再加棘轮（不许新增依赖环、分层倒置等）。不通过时退出码为 1，可直接放进 CI 或提交钩子")
  .argument("[path]", "仓库路径", ".")
  .option("-b, --baseline <ref>", "棘轮基线：相对这个提交不许新增约定里拦下的问题，如 origin/main")
  .option("--json", "输出完整 JSON", false)
  .action(async (path: string, opts: { baseline?: string; json: boolean }) => {
    const root = resolve(path);
    assertDirectory(root);
    let config: RepolensConfig;
    let lock: ArchitectureLock | null;
    try {
      config = loadConfig(root);
      lock = loadLock(root);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(2);
    }
    if (config.rules.length === 0 && lock === null && opts.baseline === undefined) {
      process.stdout.write(opts.json ? `${JSON.stringify({ rules: [], lock: null, unapproved: [], ratchet: null, passed: true }, null, 2)}\n` : NOTHING_TO_CHECK);
      return;
    }
    const progress = opts.json ? undefined : reportProgress;
    try {
      const report = await runCheck(root, { baseline: opts.baseline, onProgress: progress });
      if (progress) process.stderr.write("\n");
      process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatCheckReport(report));
      if (!report.passed) process.exitCode = 1;
    } catch (err) {
      if (!(err instanceof BaselineError)) throw err;
      process.stderr.write(`\n${err.message}\n`);
      process.exit(2);
    }
  });

program
  .command("lock")
  .description("把现在的模块间依赖记成批准过的清单（.repolens.lock.json，随代码提交）；之后新长出来的依赖要重新运行它批准，批准就出现在代码评审里")
  .argument("[path]", "仓库路径", ".")
  .action(async (path: string) => {
    const root = resolve(path);
    assertDirectory(root);
    let previous: ArchitectureLock | null = null;
    try {
      previous = loadLock(root);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}，将按现在的依赖重写\n`);
    }
    await scanRepo({ root, structureOnly: true, onProgress: reportProgress });
    process.stderr.write("\n");
    const db = openDb(indexPath(root));
    try {
      const lock = buildLock(db);
      writeLock(root, lock);
      refreshConventions(db, { lock });
      process.stdout.write(formatLockReport(previous, lock));
    } finally {
      db.close();
    }
  });

program
  .command("mcp")
  .description("以 MCP（stdio）把结构索引交给 AI 编程助手：模块名片、调用关系、约定、变更报告和约定检查")
  .argument("[path]", "仓库路径", ".")
  .action(async (path: string) => {
    const root = resolve(path);
    assertDirectory(root);
    await serveMcp({ root, version });
  });

const PHASE_LABELS: Record<ScanPhase, string> = {
  discover: "发现文件",
  parse: "解析语法",
  resolve: "解析依赖",
  link: "链接图谱",
  rollup: "聚合指标",
  enrich: "生成语义",
  index: "建立索引",
};

let lastPhase: ScanPhase | null = null;

function reportProgress(phase: ScanPhase, done: number, total: number): void {
  if (!process.stderr.isTTY) {
    if (phase !== lastPhase) {
      process.stderr.write(`${PHASE_LABELS[phase]}…\n`);
      lastPhase = phase;
    }
    return;
  }
  const label = PHASE_LABELS[phase].padEnd(8, " ");
  process.stderr.write(`\r${label} ${progressBar(done, total)} ${done}/${total}   `);
}

/**
 * Record it in the 'Scanned Warehouses' list; the warehouse selector on the interface reads from it.
 *
 * Failure should not affect the main process: the checklist is just a convenient cache, the home directory is not writable (container, restricted)
 * Scanning and browsing themselves are completely unaffected when (the environment) is present, so there is no reason to interrupt it.
 */
function remember(root: string): void {
  try {
    rememberRepo(root);
  } catch (err) {
    process.stderr.write(`（仓库清单未能更新：${(err as Error).message}）\n`);
  }
}

function assertDirectory(root: string): void {
  if (!existsSync(root)) {
    process.stderr.write(`路径不存在：${root}\n`);
    process.exit(1);
  }
}

await program.parseAsync(process.argv);
