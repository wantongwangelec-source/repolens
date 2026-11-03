import type { ChangeReportDto, DependencyChangeDto, FileChangeDto, SymbolChangeDto } from "@repolens/core/types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { changedRanges } from "../code/declaration";
import { SignatureText } from "../code/Signature";
import { type NodeScope, inScope } from "../graph/scope";
import { BehaviorSection, ClusterSection, UntestedSection } from "../insight/ChangeInsight";
import { translateMessage, useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { useChangesStore } from "../store/useChangesStore";
import {
  ChangeHint as Hint,
  ChangeRow as Row,
  ChangeSection as Section,
  ChangeTag as Tag,
  MARK,
  MARK_COLOR,
} from "../ui/change-rows";
import { IO_LABELS } from "../ui/visual";
import { CommitPicker } from "./CommitPicker";

/** About the same delay as the native title, no flicker when hovering the mouse over the list */
const HOVER_DELAY_MS = 350;

/**
 * Change perspective: Compared to a certain commit, what does this change mean structurally?
 *
 * Sort according to the order of review: first look at which module dependencies and external libraries have been added (whether the architecture has been quietly changed).
 * Next, see which entry points will reach the modified code (impact scope), and finally, there is a per-file symbol list.
 */
export function ChangesBody({ scope }: { scope: NodeScope | null }) {
  const t = useT();
  const status = useChangesStore((s) => s.status);
  const report = useChangesStore((s) => s.report);
  const error = useChangesStore((s) => s.error);
  const base = useChangesStore((s) => s.base);
  const compare = useChangesStore((s) => s.compare);

  useEffect(() => {
    if (status === "idle") void compare();
  }, [status, compare]);

  return (
    <>
      <CommitPicker
        base={base}
        baseCommit={report && report.base.ref === base ? report.base.commit : null}
        busy={status === "loading"}
        onPick={(ref) => void compare(ref)}
      />
      <LiveToolbar />

      {status === "loading" && !report && (
        <Hint>{t("正在为基线提交建立结构索引，第一次对比某个提交需要几秒。")}</Hint>
      )}
      {status === "error" && <Hint tone="danger">{error}</Hint>}
      {report && <ReportView full={report} scope={scope} />}
    </>
  );
}

/**
 * "'Rescan and Compare' stages the current changes in the workspace into the index and then compares them; after turning on 'Live,' the server monitors the files,
 * AI updates one place, it will update here automatically, no need to click again.
 */
function LiveToolbar() {
  const t = useT();
  const repoId = useAppStore((s) => s.repoId);
  const watch = useAppStore((s) => s.watchStatus);
  const rescanning = useChangesStore((s) => s.rescanning);
  const loading = useChangesStore((s) => s.status === "loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = watch?.enabled ?? false;

  const toggle = () => {
    if (repoId === null) return;
    setBusy(true);
    setError(null);
    void api.setWatch(repoId, !enabled)
      .then((status) => useAppStore.getState().setWatchStatus(status))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="px-3 pt-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={rescanning || loading}
          onClick={() => void useChangesStore.getState().rescanAndCompare()}
          title={t("把工作区此刻的改动收进索引再对比（只刷新结构，不调用模型）")}
          className="rounded border border-[var(--color-line)] px-2 py-0.5 text-[10.5px] text-[var(--color-ink-muted)] transition-colors enabled:hover:border-[var(--color-line-strong)] enabled:hover:text-[var(--color-ink)] disabled:cursor-wait disabled:opacity-60"
        >
          {rescanning ? t("正在收进改动…") : loading ? t("正在对比…") : t("重新扫描并对比")}
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy || repoId === null}
          onClick={toggle}
          title={t("盯着文件变化：AI 改一处，结构索引和这份报告跟着更新")}
          className="ml-auto flex items-center gap-1.5 text-[10.5px] transition-colors disabled:opacity-60"
          style={{ color: enabled ? "var(--color-success)" : "var(--color-ink-faint)" }}
        >
          <span className={`relative inline-flex h-3 w-5 items-center rounded-full transition-colors ${enabled ? "bg-[var(--color-success)]/40" : "bg-[var(--color-surface-3)]"}`}>
            <span className={`absolute h-2 w-2 rounded-full transition-all ${enabled ? "left-[10px] bg-[var(--color-success)]" : "left-0.5 bg-[var(--color-ink-faint)]"}`} />
          </span>
          {watch?.refreshing ? t("刷新中…") : t("实时")}
        </button>
      </div>
      {(error ?? watch?.error) && (
        <div className="mt-1 text-[10.5px] text-[var(--color-warn)]">{translateMessage((error ?? watch?.error) as string)}</div>
      )}
    </div>
  );
}

/**
 * Only keep the changes that fall within the focus node. Besides itself, if anything goes inside the entry and makes changes, keep those too—
 * "Which entry points will be affected if this part is changed" is exactly the impact they want to see when focusing. External libraries are for the whole repository and are not listed when focusing.
 */
function scopeReport(report: ChangeReportDto, scope: NodeScope): ChangeReportDto {
  const symbolPath = new Map(report.symbols.flatMap((s) => (s.id ? [[s.id, s.path] as const] : [])));
  const reaches = (id: string) => {
    const path = symbolPath.get(id);
    return path !== undefined && inScope(scope, path, id);
  };
  return {
    ...report,
    files: report.files.filter((file) => inScope(scope, file.path)),
    symbols: report.symbols.filter((symbol) => inScope(scope, symbol.path, symbol.id)),
    dependencies: report.dependencies.filter((dep) => dependencyInScope(dep, scope)),
    externals: { added: [], removed: [] },
    findings: report.findings.filter((finding) => inScope(scope, finding.path, finding.scopeKey)),
    entries: report.entries.filter((entry) =>
      inScope(scope, entry.path, entry.symbolId) || entry.via.some((v) => reaches(v.id))),
    behavior: report.behavior.filter((change) => inScope(scope, change.path, change.id)),
    clusters: report.clusters.filter((cluster) => cluster.members.some(reaches)),
  };
}

/** Dependency edges only exist at the package and directory levels; when focusing on files or symbols, there is nothing that matches. */
function dependencyInScope(dep: DependencyChangeDto, scope: NodeScope): boolean {
  if (scope.kind === "package" && dep.level === "package") {
    const name = scope.id.slice("pkg:".length);
    return dep.source === name || dep.target === name;
  }
  if (scope.kind === "package" || scope.kind === "directory") {
    return dep.level === "directory" && (inScope(scope, dep.source) || inScope(scope, dep.target));
  }
  return false;
}

function ReportView({ full, scope }: { full: ChangeReportDto; scope: NodeScope | null }) {
  const t = useT();
  const report = useMemo(() => (scope ? scopeReport(full, scope) : full), [full, scope]);
  const showNoise = useAppStore((s) => s.showNoise);
  const files = useMemo(
    () => report.files.filter((file) => showNoise || file.role === "source"),
    [report.files, showNoise],
  );
  const symbols = useMemo(
    () => report.symbols.filter((symbol) => showNoise || symbol.role === "source"),
    [report.symbols, showNoise],
  );
  const exported = symbols.filter((symbol) => symbol.exported);
  const hidden = report.files.length - files.length;
  const indexedAt = report.headIndexedAt ? new Date(report.headIndexedAt).toLocaleString() : null;

  return (
    <div className="thin-scroll flex-1 overflow-y-auto pb-3">
      <div className="px-3 pt-1.5 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
        <span className="mono">
          {report.base.ref === report.base.commit ? report.base.commit.slice(0, 8) : `${report.base.ref} · ${report.base.commit.slice(0, 8)}`}
        </span>
        {" → "}
        {report.head
          ? <span className="mono">{report.head.ref} · {report.head.commit.slice(0, 8)}</span>
          : t("上次扫描时的代码")}
        {!report.head && indexedAt && <span> ({indexedAt})</span>}
      </div>

      {full.files.length === 0 ? (
        <Hint>{t("和基线相比没有结构变化。改完代码后重新扫描再对比。")}</Hint>
      ) : scope && report.files.length === 0 && report.entries.length === 0 && report.dependencies.length === 0 ? (
        <Hint>{t("{name} 里没有改动。", { name: scope.label })}</Hint>
      ) : (
        <>
          <Summary report={report} files={files} symbols={symbols} />
          <ClusterSection report={report} />
          <BehaviorSection report={report} />
          <DependencySection report={report} />
          <EntrySection report={report} />
          <FindingSection report={report} />
          <Section title={t("对外接口变化")} count={exported.length}>
            {exported.map((symbol) => <SymbolRow key={`${symbol.path}:${symbol.name}:${symbol.line}:${symbol.status}`} symbol={symbol} showPath />)}
          </Section>
          <UntestedSection symbols={symbols} />
          <FileSection files={files} symbols={symbols} />
          {hidden > 0 && (
            <Hint>{t("另有 {count} 个测试、配置等文件的改动未列出，打开「显示噪音」可见。", { count: hidden })}</Hint>
          )}
        </>
      )}
    </div>
  );
}

function Summary({ report, files, symbols }: { report: ChangeReportDto; files: FileChangeDto[]; symbols: SymbolChangeDto[] }) {
  const t = useT();
  const count = (status: SymbolChangeDto["status"]) => symbols.filter((s) => s.status === status).length;
  const added = report.dependencies.filter((d) => d.status === "added").length;
  const removed = report.dependencies.filter((d) => d.status === "removed").length;
  return (
    <div className="mx-3 mt-2 grid grid-cols-3 gap-1 text-center">
      <Stat label={t("改动文件")} value={String(files.length)} />
      <Stat label={t("改动符号")} value={`+${count("added")} ~${count("modified")} −${count("removed")}`} />
      <Stat label={t("依赖变化")} value={`+${added} −${removed}`} highlight={added > 0} />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded border border-[var(--color-line)] px-1 py-1">
      <div className={`mono text-[11px] tabular-nums ${highlight ? "text-[var(--color-warn)]" : "text-[var(--color-ink)]"}`}>{value}</div>
      <div className="text-[9.5px] text-[var(--color-ink-faint)]">{label}</div>
    </div>
  );
}

function DependencySection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const { added, removed } = report.externals;
  const total = report.dependencies.length + added.length + removed.length;
  return (
    <Section title={t("模块依赖")} count={total}>
      {report.dependencies.map((dep) => (
        <Row
          key={`${dep.level}:${dep.type}:${dep.source}:${dep.target}:${dep.status}`}
          status={dep.status}
          onClick={() => void reveal(dep.level === "package" ? `pkg:${dep.source}` : `dir:${dep.source}`)}
          title={`${dep.source} → ${dep.target}`}
        >
          <span className="mono truncate-start truncate">{shortPath(dep.source)} → {shortPath(dep.target)}</span>
          <span className="ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">
            {dep.level === "package" ? t("包级") : ""}{dep.type === "references" ? t("仅类型") : dep.type === "http" ? "HTTP" : ""} {dep.count}
          </span>
        </Row>
      ))}
      {added.map((name) => (
        <Row key={`ext+${name}`} status="added"><span className="mono truncate">{name}</span><Tag>{t("外部库")}</Tag></Row>
      ))}
      {removed.map((name) => (
        <Row key={`ext-${name}`} status="removed"><span className="mono truncate">{name}</span><Tag>{t("外部库")}</Tag></Row>
      ))}
    </Section>
  );
}

function EntrySection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  return (
    <Section title={t("入口与影响面")} count={report.entries.length}>
      {report.entries.map((entry) => (
        <Row
          key={`${entry.status}:${entry.kind}:${entry.label}:${entry.path}`}
          status={entry.status}
          onClick={entry.symbolId ? () => void reveal(entry.symbolId as string) : undefined}
          title={entry.via.length > 0
            ? t("走到改动：{names}", { names: entry.via.map((v) => `${v.name} (${v.depth})`).join(", ") })
            : entry.path}
        >
          <span className="shrink-0 rounded border border-[var(--color-line)] px-1 text-[9px] uppercase text-[var(--color-accent)]">
            {entry.kind === "public-api" ? "api" : entry.kind}
          </span>
          <span className="truncate">{entry.label}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {(entry.ioAdded ?? []).map((kind) => (
              <Tag key={`+${kind}`} tone="warn">{t("新碰 {io}", { io: t(IO_LABELS[kind]) })}</Tag>
            ))}
            {(entry.ioRemoved ?? []).map((kind) => (
              <Tag key={`-${kind}`}>{t("不再碰 {io}", { io: t(IO_LABELS[kind]) })}</Tag>
            ))}
            {entry.status === "affected" && (
              <span className="text-[9.5px] text-[var(--color-ink-faint)]">
                {t("{count} 处改动", { count: entry.via.length })}
              </span>
            )}
          </span>
        </Row>
      ))}
    </Section>
  );
}

function FindingSection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  return (
    <Section title={t("体检变化")} count={report.findings.length}>
      {report.findings.map((finding) => (
        <Row
          key={`${finding.status}:${finding.scopeKey}:${finding.title}`}
          status={finding.status}
          onClick={finding.status === "added" ? () => void reveal(finding.scopeKey) : undefined}
          title={finding.detail}
        >
          <span className="truncate">{finding.title}</span>
          <Tag>{finding.status === "added" ? t("新增") : t("消除")}</Tag>
        </Row>
      ))}
    </Section>
  );
}

function FileSection({ files, symbols }: { files: FileChangeDto[]; symbols: SymbolChangeDto[] }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const reveal = useAppStore((s) => s.reveal);
  const byFile = useMemo(() => {
    const out = new Map<string, SymbolChangeDto[]>();
    for (const symbol of symbols) {
      const bucket = out.get(symbol.path);
      if (bucket) bucket.push(symbol); else out.set(symbol.path, [symbol]);
    }
    return out;
  }, [symbols]);

  return (
    <Section title={t("逐文件")} count={files.length}>
      {files.map((file) => {
        const changes = byFile.get(file.path) ?? [];
        const expanded = open === file.path;
        return (
          <div key={`${file.status}:${file.path}`}>
            <Row
              status={file.status}
              onClick={() => {
                setOpen(expanded ? null : file.path);
                if (file.id) void reveal(file.id);
              }}
              title={file.from ? t("从 {path} 移动而来", { path: file.from }) : file.path}
            >
              <span className="mono truncate-start truncate">{file.path}</span>
              {changes.length > 0 && (
                <span className="ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{changes.length}</span>
              )}
            </Row>
            {expanded && changes.map((symbol) => (
              <SymbolRow key={`${symbol.name}:${symbol.line}:${symbol.status}`} symbol={symbol} indent />
            ))}
          </div>
        );
      })}
    </Section>
  );
}

function SymbolRow({ symbol, showPath, indent }: { symbol: SymbolChangeDto; showPath?: boolean; indent?: boolean }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  const name = symbolName(symbol);
  const cosmetic = symbol.status === "modified" && !symbol.shapeChanged;
  const signatureChanged = symbol.status === "modified" && symbol.signature !== symbol.signatureBefore;
  const complexer = symbol.complexityBefore !== null && symbol.complexity - symbol.complexityBefore >= 5;

  const hide = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setAnchor(null);
  }, []);
  useEffect(() => hide, [hide]);

  return (
    // Hovering hanging on the outer layer: deleted symbols cannot be clicked, the button is disabled, and some browsers do not send it pointer events.
    <div
      onPointerEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        timer.current = window.setTimeout(() => setAnchor(rect), HOVER_DELAY_MS);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
    >
      <Row
        status={symbol.status}
        indent={indent}
        onClick={symbol.id ? () => void reveal(symbol.id as string) : undefined}
      >
        <span className="mono truncate">{name}</span>
        {showPath && <span className="mono truncate text-[9.5px] text-[var(--color-ink-faint)]">{symbol.path.split("/").at(-1)}</span>}
        <span className="ml-auto flex shrink-0 gap-1">
          {signatureChanged && <Tag tone="warn">{t("签名")}</Tag>}
          {complexer && <Tag tone="warn">{`${symbol.complexityBefore}→${symbol.complexity}`}</Tag>}
          {cosmetic && <Tag>{t("仅格式")}</Tag>}
          {symbol.tests === 0 && !cosmetic && (symbol.kind === "function" || symbol.kind === "method") && (
            <Tag tone="warn">{t("没测试")}</Tag>
          )}
        </span>
      </Row>
      {anchor && <SymbolCard symbol={symbol} anchor={anchor} onClose={hide} />}
    </div>
  );
}

function symbolName(symbol: SymbolChangeDto): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

/** Floating on the right side of the sidebar, above the canvas: signatures can easily be hundreds of characters long, while the sidebar can only fit a name */
function SymbolCard({ symbol, anchor, onClose }: { symbol: SymbolChangeDto; anchor: DOMRect; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);
  const signatureChanged = symbol.status === "modified" && symbol.signature !== symbol.signatureBefore;
  const complexityChanged = symbol.complexityBefore !== null && symbol.complexityBefore !== symbol.complexity;
  const cosmetic = symbol.status === "modified" && !symbol.shapeChanged;
  const changed = signatureChanged && symbol.signatureBefore && symbol.signature
    ? changedRanges(symbol.signatureBefore, symbol.signature)
    : null;

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top - 6, window.innerHeight - height - 8)));
  }, [anchor]);

  // After the list scrolls, the cards are misaligned with that row.
  useEffect(() => {
    window.addEventListener("scroll", onClose, true);
    return () => window.removeEventListener("scroll", onClose, true);
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="anim-fade pointer-events-none fixed z-50 w-max overflow-hidden rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] shadow-2xl"
      style={{ top, left: anchor.right + 8, minWidth: 240, maxWidth: Math.max(240, Math.min(520, window.innerWidth - anchor.right - 24)) }}
    >
      <div className="flex items-baseline gap-2 border-b border-[var(--color-line)] px-2.5 py-1.5">
        <span className="mono shrink-0 text-[11px]" style={{ color: MARK_COLOR[symbol.status] }}>{MARK[symbol.status]}</span>
        <span className="mono min-w-0 truncate text-[12px] text-[var(--color-ink)]">{symbolName(symbol)}</span>
        <span className="mono ml-auto min-w-0 shrink truncate-start truncate pl-2 text-[10px] text-[var(--color-ink-faint)]">
          {symbol.path}:{symbol.line}
        </span>
      </div>
      {signatureChanged ? (
        <div className="space-y-1 px-2.5 py-1.5">
          {symbol.signatureBefore && (
            <SignatureDiff mark="−" color="var(--color-danger)" code={symbol.signatureBefore} path={symbol.path} ranges={changed?.before} />
          )}
          {symbol.signature && (
            <SignatureDiff mark="+" color="var(--color-success)" code={symbol.signature} path={symbol.path} ranges={changed?.after} />
          )}
        </div>
      ) : symbol.signature ? (
        <div className="px-2.5 py-1.5">
          <SignatureText code={symbol.signature} path={symbol.path} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-2.5 border-t border-[var(--color-line)] px-2.5 py-1 text-[10.5px] text-[var(--color-ink-faint)]">
        <span>
          {symbol.status === "removed"
            ? t("基线里有 {count} 个调用方", { count: symbol.callers })
            : t("{count} 个调用方", { count: symbol.callers })}
        </span>
        {complexityChanged && <span>{t("复杂度 {from} → {to}", { from: symbol.complexityBefore ?? 0, to: symbol.complexity })}</span>}
        {cosmetic && <span>{t("只改了命名、字面量或格式")}</span>}
      </div>
    </div>,
    document.body,
  );
}

function SignatureDiff({
  mark, color, code, path, ranges = [],
}: {
  mark: string;
  color: string;
  code: string;
  path: string;
  /** A few passages different from the other version, deepening the background color */
  ranges: Array<[number, number]> | undefined;
}) {
  const className = mark === "+" ? DIFF_ADDED : DIFF_REMOVED;
  const marks = ranges.map(([from, to]) => ({ from, to, className }));
  return (
    <div className="flex gap-1.5 rounded px-1.5 py-0.5" style={{ background: `color-mix(in srgb, ${color} 9%, transparent)` }}>
      <span className="mono shrink-0 text-[11px] leading-[1.6]" style={{ color }}>{mark}</span>
      <div className="min-w-0 flex-1">
        <SignatureText code={code} path={path} marks={marks} />
      </div>
    </div>
  );
}

const DIFF_ADDED = "rounded-sm bg-[var(--color-success)]/25";
const DIFF_REMOVED = "rounded-sm bg-[var(--color-danger)]/25";

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}
