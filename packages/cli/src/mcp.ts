import {
  BaselineError,
  buildChangeReport,
  getBoundary,
  getEntryPoints,
  getFindingSummary,
  getFindings,
  getModuleCard,
  getOverview,
  getSpec,
  getSymbolDetail,
  indexChangeFilter,
  indexPath,
  loadConfig,
  loadLock,
  lookupNode,
  openDb,
  runCheck,
  scanRepo,
  search,
  FINDING_KINDS,
  type Db,
  type FindingKind,
  type LookupCandidate,
} from "@repolens/core";
import { watch, type FSWatcher } from "node:fs";
import { createInterface } from "node:readline";
import { formatCheckReport, NOTHING_TO_CHECK } from "./check-report.js";
import { formatChangeReport } from "./diff-report.js";
import { ENTRY_NAMES, FINDING_NAMES, IO_NAMES } from "./labels.js";

/** New comes first; for the version the client wants, we follow it if we know it, otherwise, we return the latest one. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `RepoLens 从语法树建出这个仓库的结构索引：模块、依赖、调用关系、入口、测试覆盖、改动历史和写进仓库的架构约定。
结构由解析器决定，不是模型猜的，可以当事实用。

改代码之前：conventions 读约定（依赖规则、确认过的分层、批准过的模块间依赖），module 看要动的模块对外暴露什么、
谁在用它，symbol 看函数的调用方和走得到它的测试，boundary 看两个模块之间到底依赖了什么。
改完之后：changes 看这次改动在结构上做了什么（新依赖、新 I/O、受影响的入口、没被测试走到的改动），
check 跑约定检查；不通过就修，别绕过。新增模块间依赖需要人运行 repolens lock 批准。`;

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** The tool's own failure (parameters not recognized, baseline does not exist): return it to the model as a result, so it can try again with different parameters */
class ToolError extends Error {}

type Args = Record<string, unknown>;

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (args: Args) => Promise<string>;
}

export interface McpOptions {
  root: string;
  version: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (message: string) => void;
}

/**
 * Hand over the index to the AI programming assistant using MCP (stdio, line-separated JSON-RPC).
 * stdout only carries protocol messages, logs are always written to stderr. Returns when the input stream is closed.
 */
export function serveMcp(options: McpOptions): Promise<void> {
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const server = new RepoLensMcp(options.root, options.version, log);
  const write = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    void server.receive(line).then((reply) => {
      if (reply !== null) write(reply);
    });
  });
  return new Promise((done) => {
    lines.on("close", () => {
      void server.close().then(done);
    });
  });
}

export class RepoLensMcp {
  private dirty = true;
  private queue: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | null = null;
  private readonly tools: ToolSpec[];

  constructor(
    private readonly root: string,
    private readonly version: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.tools = this.defineTools();
    try {
      const relevant = indexChangeFilter(root);
      this.watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => {
        if (relevant(typeof file === "string" ? file : null)) this.dirty = true;
      });
      this.watcher.on("error", () => this.stopWatching());
    } catch {
      // When recursive monitoring is not supported, it degrades to incrementally scanning everything before each call.
      this.watcher = null;
    }
  }

  /** Wait until the scans added in the background during the handshake and the queued queries are finished before returning: the index library open on Windows cannot be deleted or moved */
  async close(): Promise<void> {
    this.stopWatching();
    await this.queue;
  }

  /** Process a line of input; return null when notifications and responses themselves do not require a reply */
  async receive(line: string): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return errorReply(null, -32700, "Parse error");
    }
    if (Array.isArray(parsed)) {
      const replies = (await Promise.all(parsed.map((message) => this.dispatch(message)))).filter((reply) => reply !== null);
      return replies.length > 0 ? replies : null;
    }
    return this.dispatch(parsed);
  }

  private async dispatch(raw: unknown): Promise<unknown> {
    const message = (typeof raw === "object" && raw !== null ? raw : {}) as JsonRpcMessage;
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (typeof message.method !== "string") {
      // Response sent back by the client (there won't be any if we don't send a request) or messages with incorrect format
      return id === null || "result" in message || "error" in message ? null : errorReply(id, -32600, "Invalid Request");
    }
    const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Args;
    try {
      const result = await this.call(message.method, params);
      return id === null ? null : { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (id === null) return null;
      if (err instanceof RpcError) return errorReply(id, err.code, err.message);
      return errorReply(id, -32603, (err as Error).message);
    }
  }

  private async call(method: string, params: Args): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
        // After the handshake, update the index to the latest in the background; the first tool call does not need to wait for the entire scan.
        void this.exclusive(() => this.refreshIfDirty()).catch((err: Error) => this.log(`RepoLens：索引刷新失败：${err.message}`));
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "repolens", title: "RepoLens", version: this.version },
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: this.tools.map(({ name, title, description, inputSchema }) => ({
            name,
            title,
            description,
            inputSchema,
            annotations: { title, readOnlyHint: true, openWorldHint: false },
          })),
        };
      case "tools/call": {
        const name = params["name"];
        const tool = this.tools.find((candidate) => candidate.name === name);
        if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
        const args = (typeof params["arguments"] === "object" && params["arguments"] !== null ? params["arguments"] : {}) as Args;
        try {
          return { content: [{ type: "text", text: await tool.run(args) }] };
        } catch (err) {
          if (err instanceof ToolError || err instanceof BaselineError) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
          throw err;
        }
      }
      default:
        if (method.startsWith("notifications/")) return null;
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Index
  // ---------------------------------------------------------------------------

  /** Scanning and reading indexes are queued: when AI calls concurrently, it will not scan and write to the database twice at the same time, nor will it read a graph that is only halfway scanned. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The AI probably changed the code between the two calls: if any files have changed, first perform an incremental scan that only builds the structure. */
  private async refreshIfDirty(): Promise<void> {
    if (!this.dirty && this.watcher !== null) return;
    this.dirty = false;
    try {
      const stats = await scanRepo({ root: this.root, structureOnly: true });
      if (stats.filesParsed > 0 || stats.filesDeleted > 0) {
        this.log(`RepoLens：索引已更新（解析 ${stats.filesParsed} 个文件，删除 ${stats.filesDeleted} 个，${(stats.durationMs / 1000).toFixed(1)}s）`);
      }
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  private read(run: (db: Db) => string): Promise<string> {
    return this.exclusive(async () => {
      await this.refreshIfDirty();
      const db = openDb(indexPath(this.root), { readonly: true });
      try {
        return run(db);
      } finally {
        db.close();
      }
    });
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  // ---------------------------------------------------------------------------
  // Tool
  // ---------------------------------------------------------------------------

  private defineTools(): ToolSpec[] {
    const root = this.root;
    return [
      {
        name: "overview",
        title: "仓库全貌",
        description: "仓库的全貌：规模（源码行和总行数分开）、包、分层（确认过的优先于 AI 提议）、主要入口、体检概况、约定和改动历史概况。刚接触这个仓库时先调它。",
        inputSchema: { type: "object", properties: {} },
        run: () => this.read((db) => overviewText(db, root)),
      },
      {
        name: "conventions",
        title: "约定",
        description: "写进仓库的架构约定：依赖规则（哪些模块不许依赖哪些）、确认过的分层（下层不许依赖上层）、依赖锁（批准过的模块间依赖，新增的要人批准）和棘轮（相对基线不许新增的问题）。写代码前先读，别写出违反约定的依赖。",
        inputSchema: { type: "object", properties: {} },
        run: async () => conventionsText(root),
      },
      {
        name: "module",
        title: "模块名片",
        description: "一个包、目录或文件的名片：对外接口（被外面用到的符号和签名）、它依赖谁、谁依赖它、外部库、I/O、入口、测试覆盖、改动热点、所在分层。把模块当黑盒用时，读名片就够了。",
        inputSchema: {
          type: "object",
          properties: { module: { type: "string", description: "包名、目录或文件路径（相对仓库根），或节点 id（pkg:… / dir:… / file:…）" } },
          required: ["module"],
        },
        run: (args) => this.read((db) => {
          const id = mustFind(db, requireString(args, "module"), "scope");
          const card = getModuleCard(db, id);
          if (!card) throw new ToolError(`${id} 不是可以出名片的范围`);
          return moduleText(card);
        }),
      },
      {
        name: "find",
        title: "找符号和文件",
        description: "按名字找函数、类、文件、目录或包，返回节点 id 和位置，供 symbol / module / spec 继续查。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "名字或名字的一部分，空格分隔多个词" },
            includeTests: { type: "boolean", description: "是否也搜测试文件，默认只搜源码" },
          },
          required: ["query"],
        },
        run: (args) => this.read((db) => {
          const hits = search(db, requireString(args, "query"), 25, args["includeTests"] === true ? ["source", "test"] : ["source"]);
          if (hits.length === 0) return "没有找到。换个写法，或用 includeTests 把测试文件也搜进来。";
          return hits.map((hit) => `${hit.label}  ${hit.detail}  [${hit.id}]`).join("\n");
        }),
      },
      {
        name: "symbol",
        title: "函数详情",
        description: "一个函数、方法或类型的详情：签名、位置、复杂度、调用方（谁依赖它，改签名前必看）、它调用了谁、外部调用、走得到它的测试用例。",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "函数名（可带容器，如 IndexWriter.upsertFile）、文件路径#名字，或节点 id（sym:…）" },
          },
          required: ["symbol"],
        },
        run: (args) => this.read((db) => {
          const id = mustFind(db, requireString(args, "symbol"), "symbol");
          const detail = getSymbolDetail(db, Number(id.slice(4)), root);
          if (!detail) throw new ToolError(`找不到 ${id}`);
          return symbolText(detail);
        }),
      },
      {
        name: "boundary",
        title: "两个模块之间",
        description: "两个模块之间的契约：from 引了 to 的哪些文件、用了哪些符号（调用次数、调用方数）、有没有绕过包入口、有没有按 URL 对上的 HTTP 请求。两边没有直接依赖时给出最短的一条 import 链。",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "依赖方：包名、目录、文件路径或节点 id" },
            to: { type: "string", description: "被依赖方：包名、目录、文件路径或节点 id" },
          },
          required: ["from", "to"],
        },
        run: (args) => this.read((db) => {
          const from = mustFind(db, requireString(args, "from"), "scope");
          const to = mustFind(db, requireString(args, "to"), "scope");
          const boundary = getBoundary(db, from, to);
          if (!boundary) throw new ToolError(`${from} 和 ${to} 不能比较：两者不能互相包含`);
          return boundaryText(boundary);
        }),
      },
      {
        name: "spec",
        title: "描述它的测试",
        description: "沿调用关系走得到某个函数、文件或模块的测试用例，按测试文件和用例组归好。用例标题就是人写下的预期行为；改动前读它，改动后跑它。",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string", description: "函数名、文件或目录路径、包名，或节点 id" } },
          required: ["target"],
        },
        run: (args) => this.read((db) => {
          const id = mustFind(db, requireString(args, "target"), "any");
          const spec = getSpec(db, id);
          if (!spec || spec.cases === 0) return "没有测试用例沿调用关系走得到这里。改动这里时，没有测试会替你发现回归。";
          return specText(spec);
        }),
      },
      {
        name: "findings",
        title: "体检结论",
        description: "结构体检的结论：依赖环、违反依赖规则、未批准的依赖、分层倒置、绕过包入口、重复代码、过大、隐性耦合（总是一起改却没有依赖关系）、文档过期。同一严重程度里改得勤的排前面。",
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", description: "只看某个包、目录、文件或函数里的；缺省为整个仓库" },
            kind: { type: "string", enum: [...FINDING_KINDS], description: "只看某一类" },
          },
        },
        run: (args) => this.read((db) => {
          const scope = optionalString(args, "scope");
          const kind = optionalString(args, "kind");
          if (kind !== undefined && !FINDING_KINDS.includes(kind as FindingKind)) throw new ToolError(`kind 只能是 ${FINDING_KINDS.join("、")}`);
          const findings = getFindings(db, {
            scope: scope === undefined ? undefined : mustFind(db, scope, "any"),
            kind: kind as FindingKind | undefined,
            limit: 40,
          });
          if (findings.length === 0) return "没有体检结论。";
          return findings.map((f) =>
            `[${f.severity}] ${FINDING_NAMES[f.kind]}：${f.title}  ${f.path}${f.recentCommits ? `（近 90 天改过 ${f.recentCommits} 次）` : ""}\n    ${f.detail.replace(/\s+/g, " ").slice(0, 300)}  [${f.scopeKey}]`,
          ).join("\n");
        }),
      },
      {
        name: "changes",
        title: "这次改了什么",
        description: "工作区（含未提交改动）相对基线提交在结构上的变化：按调用关系归组的改动单元和风险、行为变化（新调了谁、开始碰哪类 I/O）、对外接口变化、模块依赖和外部库变化、受影响的入口、新增或消除的体检问题、改了却没有测试走到的函数。",
        inputSchema: {
          type: "object",
          properties: { base: { type: "string", description: "基线：分支、tag、HEAD~n 或 sha，默认 HEAD" } },
        },
        run: (args) => this.exclusive(async () => {
          await this.refreshIfDirty();
          const report = await buildChangeReport(root, { base: optionalString(args, "base") ?? "HEAD" });
          return formatChangeReport(report);
        }),
      },
      {
        name: "check",
        title: "约定检查",
        description: "跑约定检查：依赖规则、依赖锁（锁里没有的模块间依赖）、给了基线时再加棘轮（相对基线新增的依赖环、分层倒置等）。和 CI 里的 repolens check 是同一套。不通过时按报告修，新依赖确实合理就请人运行 repolens lock 批准。",
        inputSchema: {
          type: "object",
          properties: { baseline: { type: "string", description: "做棘轮检查的基线：分支、tag 或 sha；缺省只查规则和依赖锁" } },
        },
        run: (args) => this.exclusive(async () => {
          const baseline = optionalString(args, "baseline");
          const config = loadConfig(root);
          if (config.rules.length === 0 && loadLock(root) === null && baseline === undefined) return NOTHING_TO_CHECK;
          this.dirty = false;
          try {
            return formatCheckReport(await runCheck(root, { baseline }));
          } catch (err) {
            this.dirty = true;
            throw err;
          }
        }),
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Parameter
// ---------------------------------------------------------------------------

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new ToolError(`缺少参数 ${key}`);
  return value.trim();
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function mustFind(db: Db, text: string, want: "scope" | "symbol" | "any"): string {
  const result = lookupNode(db, text, want);
  if (result.kind === "found") return result.id;
  if (result.kind === "ambiguous") {
    throw new ToolError(`「${text}」有 ${result.candidates.length} 个同名符号，用节点 id 指定一个：\n${result.candidates.map(candidateLine).join("\n")}`);
  }
  const what = want === "scope" ? "包、目录或文件" : want === "symbol" ? "符号" : "节点";
  throw new ToolError(`认不出「${text}」这个${what}。可以先用 find 搜一下，再用返回的节点 id。`);
}

function candidateLine(candidate: LookupCandidate): string {
  return `  ${candidate.label}（${candidate.symbolKind}）${candidate.path}:${candidate.line}${candidate.role === "source" ? "" : `（${candidate.role}）`}  [${candidate.id}]`;
}

// ---------------------------------------------------------------------------
// Output: Compact text for the model to read, with each object carrying a node id, making it easy to follow up
// ---------------------------------------------------------------------------

function overviewText(db: Db, root: string): string {
  const overview = getOverview(db);
  const totals = overview.totals;
  const findings = getFindingSummary(db);
  const config = loadConfig(root);
  const lines: string[] = [];
  lines.push(`仓库 ${overview.repoName}（${overview.repoRoot}），索引于 ${overview.scannedAt}`);
  lines.push(`规模：源码 ${n(totals.sourceLoc)} 行 / ${n(totals.sourceFiles)} 个文件（含测试、文档、配置共 ${n(totals.loc)} 行 / ${n(totals.files)} 个文件），符号 ${n(totals.symbols)}`);
  if (overview.summary) lines.push(`概述（AI 生成）：${overview.summary}`);

  if (overview.layers && overview.layers.length > 0) {
    lines.push("", overview.layersConfirmed ? "分层（已确认，自上而下；下层不许依赖上层）：" : "分层（AI 提议，还没确认）：");
    overview.layers.forEach((layer, index) => {
      lines.push(`  ${index + 1}. ${layer.name}${layer.description ? ` — ${layer.description}` : ""}：${layer.nodeIds.join(", ")}`);
    });
  }

  if (overview.packages.length > 1) {
    lines.push("", `包（${overview.packages.length}）：`);
    for (const pkg of overview.packages.slice(0, 30)) lines.push(`  ${pkg.name}  ${pkg.dir}  ${n(pkg.loc)} 行  [${pkg.id}]`);
  }

  const entries = getEntryPoints(db).filter((entry) => entry.kind !== "test" && entry.fileRole === "source");
  if (entries.length > 0) {
    lines.push("", `入口（${entries.length} 个，按往下走得到的函数数排）：`);
    for (const entry of [...entries].sort((a, b) => b.reachSymbols - a.reachSymbols).slice(0, 15)) {
      const io = entry.reachIo.length > 0 ? `，碰 ${entry.reachIo.map((kind) => IO_NAMES[kind]).join("、")}` : "";
      lines.push(`  [${ENTRY_NAMES[entry.kind]}] ${entry.label}  ${entry.filePath}:${entry.line}  走到 ${entry.reachSymbols} 个函数${io}${entry.symbolId ? `  [${entry.symbolId}]` : ""}`);
    }
  }

  const byKind = Object.entries(findings.byKind).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${FINDING_NAMES[kind as FindingKind] ?? kind} ${count}`);
  lines.push("", `体检：${findings.total} 条（高 ${findings.high}）${byKind.length > 0 ? `：${byKind.join("，")}` : ""}`);
  const conventions = [
    config.rules.length > 0 ? `依赖规则 ${config.rules.length} 条` : "",
    overview.layersConfirmed ? "分层已确认" : "",
    overview.lock ? `依赖锁 ${overview.lock.dependencies} 条${overview.lock.level === "package" ? "包" : "模块"}间依赖` : "",
  ].filter(Boolean);
  lines.push(`约定：${conventions.length > 0 ? conventions.join("，") : "还没有（见 conventions）"}`);
  if (overview.history) lines.push(`历史：近一年 ${overview.history.commits} 次提交，其中 ${overview.history.aiCommits} 次标明有 AI 参与`);
  return lines.join("\n");
}

function conventionsText(root: string): string {
  const config = loadConfig(root);
  const lock = loadLock(root);
  const lines: string[] = [];
  if (config.rules.length === 0 && config.layers.length === 0 && lock === null) {
    return "这个仓库还没有写下约定（.repolens.json 的 rules / layers，.repolens.lock.json 的依赖锁）。照现有的依赖方向写，别引入新的模块间依赖和环。";
  }
  if (config.rules.length > 0) {
    lines.push(`依赖规则（${config.rules.length}）：`);
    for (const rule of config.rules) {
      const allow = rule.allow.length > 0 ? `；例外：${rule.allow.join(", ")}` : "";
      const types = rule.includeTypeOnly ? "；纯类型 import 也算" : "；纯类型 import 放行";
      lines.push(`  - ${rule.name ?? `${rule.from.join(", ")} ↛ ${rule.disallow.join(", ")}`}：${rule.from.join(", ")} 不许依赖 ${rule.disallow.join(", ")}${allow}${types}`);
      if (rule.reason) lines.push(`    理由：${rule.reason}`);
    }
    lines.push("");
  }
  if (config.layers.length > 0) {
    lines.push("分层（已确认，自上而下；下层依赖上层算分层倒置）：");
    config.layers.forEach((layer, index) => {
      lines.push(`  ${index + 1}. ${layer.name}${layer.description ? ` — ${layer.description}` : ""}：${layer.members.join(", ")}`);
    });
    lines.push("");
  }
  if (lock) {
    lines.push(`依赖锁（${lock.level === "package" ? "包" : "模块目录"}之间，${lock.dependencies.length} 条批准过的依赖；不在这里的新依赖要人运行 repolens lock 批准）：`);
    if (lock.level === "directory") lines.push(`  模块：${lock.modules.join(", ")}`);
    for (const dep of lock.dependencies) lines.push(`  ${dep.from} → ${dep.to}${dep.type === "http" ? "（HTTP）" : ""}`);
    lines.push("");
  }
  lines.push(`棘轮（repolens check --baseline <ref>）：新增即失败 ${config.ratchet.fail.join(", ") || "无"}；新增只提示 ${config.ratchet.warn.join(", ") || "无"}`);
  return lines.join("\n");
}

function moduleText(card: NonNullable<ReturnType<typeof getModuleCard>>): string {
  const lines: string[] = [];
  lines.push(`模块 ${card.label}（${card.path}）[${card.id}]${card.layer ? `  分层：${card.layer.name}${card.layer.confirmed ? "（已确认）" : "（AI 提议）"}` : ""}`);
  if (card.api.length > 0) {
    lines.push("", `对外接口（被模块外用到的 ${card.apiTotal} 个，按外部调用方数排）：`);
    for (const api of card.api.slice(0, 30)) {
      const use = [api.callers > 0 ? `外部调用方 ${api.callers}` : "", `引用文件 ${api.files}`].filter(Boolean).join("，");
      lines.push(`  ${api.signature ?? `${api.kind} ${api.name}`}  ${api.path}:${api.line}  ${use}  [${api.id}]`);
    }
  } else {
    lines.push("", "对外接口：模块外没有用到它的符号");
  }
  const link = (l: (typeof card.dependsOn)[number]) =>
    `  ${l.label}  ${l.imports} 条 import${l.typeOnly ? "（全是类型）" : ""}${l.http ? "，有 HTTP 请求" : ""}${l.names.length > 0 ? `：${l.names.join(", ")}` : ""}  [${l.id}]`;
  if (card.dependsOn.length > 0) lines.push("", "依赖：", ...card.dependsOn.map(link));
  if (card.usedBy.length > 0) lines.push("", "被依赖：", ...card.usedBy.map(link));
  if (card.externals.length > 0) lines.push("", `外部库：${card.externals.map((e) => `${e.name}（${e.files} 个文件）`).join("，")}`);
  if (card.io.length > 0) lines.push(`I/O：${card.io.map((io) => `${IO_NAMES[io.kind]} ${io.functions} 个函数`).join("，")}`);
  if (card.entries.length > 0) {
    lines.push("", "入口：", ...card.entries.slice(0, 15).map((e) => `  [${ENTRY_NAMES[e.kind]}] ${e.label}${e.symbolId ? `  [${e.symbolId}]` : ""}`));
  }
  const { functions, covered, cases } = card.tests;
  lines.push("", `测试：${cases} 个用例走到 ${covered} / ${functions} 个函数${functions > 0 ? `（${Math.round((covered / functions) * 100)}%）` : ""}`);
  if (card.history) {
    const h = card.history;
    lines.push(`历史：近一年 ${h.commits} 次提交（近 90 天 ${h.recentCommits} 次，标明 AI 参与 ${h.aiCommits} 次）`);
    if (h.hottest.length > 0) {
      lines.push(`改得最勤：${h.hottest.map((f) => `${f.path}（近 90 天 ${f.recentCommits} 次，复杂度 ${f.complexity}）`).join("，")}`);
    }
  }
  return lines.join("\n");
}

function symbolText(detail: NonNullable<ReturnType<typeof getSymbolDetail>>): string {
  const qualified = detail.container ? `${detail.container}.${detail.name}` : detail.name;
  const lines: string[] = [];
  lines.push(`${qualified}（${detail.kind}）  [${detail.id}]`);
  if (detail.signature) lines.push(`签名：${detail.signature}`);
  lines.push(`${detail.filePath}:${detail.startLine}-${detail.endLine}，复杂度 ${detail.complexity}${detail.exported ? "，导出" : ""}${detail.isAsync ? "，async" : ""}`);
  if (detail.doc) lines.push(`注释：${detail.doc.replace(/\s+/g, " ").slice(0, 400)}`);
  if (detail.summary) lines.push(`摘要（AI 生成，以代码为准）：${detail.summary}`);
  if (detail.tests && detail.tests.total > 0) {
    lines.push("", `测试：${detail.tests.total} 个用例走得到（直接调用 ${detail.tests.direct} 个），最近的：`);
    for (const test of detail.tests.nearest) {
      lines.push(`  「${test.suite ? `${test.suite} › ` : ""}${test.name}」 ${test.path}:${test.line}，${test.depth === 1 ? "直接调用" : `隔 ${test.depth} 层`}  [${test.id}]`);
    }
  } else if (detail.testKind == null) {
    lines.push("", "测试：没有用例沿调用关系走得到它");
  }
  const relation = (r: (typeof detail.callers)[number]) =>
    `  ${r.name}  ${r.path}:${r.definedAt}${r.confidence === "exact" ? "" : `（${r.confidence}）`}${r.http ? "（HTTP）" : ""}  [${r.id}]`;
  lines.push("", `调用方（${detail.callers.length}）：`, ...(detail.callers.length > 0 ? detail.callers.slice(0, 40).map(relation) : ["  无（入口、回调，或只被测试调用）"]));
  if (detail.callers.length > 40) lines.push(`  … 另有 ${detail.callers.length - 40} 个`);
  if (detail.callees.length > 0) {
    lines.push("", `调用（${detail.callees.length}）：`, ...detail.callees.slice(0, 40).map(relation));
  }
  if (detail.externalCallees.length > 0) {
    lines.push(`外部调用：${detail.externalCallees.slice(0, 20).map((c) => `${c.name}${c.count > 1 ? ` ×${c.count}` : ""}`).join("，")}`);
  }
  if (detail.typeRelations.length > 0) {
    lines.push(`类型关系：${detail.typeRelations.map((t) => `${t.relation} ${t.target}${t.targetId ? ` [${t.targetId}]` : ""}`).join("，")}`);
  }
  return lines.join("\n");
}

function boundaryText(boundary: NonNullable<ReturnType<typeof getBoundary>>): string {
  const { from, to, totals } = boundary;
  const lines: string[] = [];
  lines.push(`${from.label}（${from.path}）→ ${to.label}（${to.path}）`);
  if (boundary.imports.length === 0 && boundary.http.length === 0) {
    if (boundary.path && boundary.path.length > 0) {
      lines.push(`没有直接依赖。最短的间接 import 链：${boundary.path.map((step) => step.path).join(" → ")}`);
    } else {
      lines.push("没有依赖，直接的和间接的都没有。");
    }
    return lines.join("\n");
  }
  lines.push(`${totals.files} 个文件，${totals.imports} 条 import（仅类型 ${totals.typeOnly}，绕过包入口 ${totals.bypass}），调用 ${totals.calls} 次，用到 ${totals.symbols} 个符号`);
  lines.push("", "import：");
  for (const imp of boundary.imports.slice(0, 40)) {
    const names = imp.names.length > 0 ? ` { ${imp.names.join(", ")} }` : "";
    lines.push(`  ${imp.fromPath}:${imp.line} → ${imp.toPath}${names}${imp.typeOnly ? "（仅类型）" : ""}${imp.bypass ? "（绕过包入口）" : ""}`);
  }
  if (boundary.symbols.length > 0) {
    lines.push("", "用到的符号：");
    for (const sym of boundary.symbols.slice(0, 40)) {
      lines.push(`  ${sym.name}（${sym.kind}）${sym.path}:${sym.line}  ${sym.importOnly ? "只被 import" : `被调 ${sym.calls} 次，${sym.callers} 个调用方`}  [${sym.id}]`);
    }
  }
  if (boundary.http.length > 0) {
    lines.push("", "HTTP（前端请求按 URL 对上的后端路由）：");
    for (const h of boundary.http.slice(0, 30)) lines.push(`  ${h.caller}（${h.callerPath}:${h.line}）→ ${h.route}（${h.routePath}）`);
  }
  return lines.join("\n");
}

function specText(spec: NonNullable<ReturnType<typeof getSpec>>): string {
  const lines: string[] = [`${spec.cases} 个测试用例沿调用关系走得到这里：`];
  for (const file of spec.files) {
    lines.push("", file.path);
    for (const suite of file.suites) {
      const indent = suite.name ? "    " : "  ";
      if (suite.name) lines.push(`  ${suite.name}`);
      for (const c of suite.cases) {
        lines.push(`${indent}「${c.name}」:${c.line}  ${c.depth === 1 ? "直接调用" : `隔 ${c.depth} 层`}${c.targets.length > 0 ? `，走到 ${c.targets.join(", ")}` : ""}  [${c.id}]`);
      }
    }
  }
  return lines.join("\n");
}

function errorReply(id: JsonRpcId | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}
