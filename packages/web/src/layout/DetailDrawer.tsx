import type {
  FileDetailDto,
  NoteDto,
  PseudocodeStepDto,
  ReadmeDto,
  SymbolDetailDto,
} from "@repolens/core/types";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { ChatDock } from "../chat/ChatDock";
import { msg, useT } from "../i18n";
import { SelectionAsk } from "../chat/SelectionAsk";
import { PseudocodePanel, stepMarkerWidth, type StepQuote } from "../code/PseudocodePanel";
import { DeclarationHeader } from "../code/Signature";
import { SourcePanel, type SourceFocus } from "../code/SourcePanel";
import { ConventionsSection } from "../insight/ConventionsSection";
import { parseEdgeSelection } from "../lib/edge";
import { EdgeBody } from "../insight/EdgeBody";
import { Grounded, missingCount } from "../insight/Grounded";
import { HistorySection } from "../insight/HistorySection";
import { ModuleCardSection } from "../insight/ModuleCard";
import { SkeletonSection } from "../insight/SkeletonSection";
import { ScopeTests, SymbolTests } from "../insight/TestsSection";
import { isTypeKind, TypeFlowSection } from "../insight/TypeFlowSection";
import { Chip, Empty, Label, Metric, Skeleton } from "../ui/panel";
import { formatCount, languageColor, symbolGlyph } from "../ui/visual";
import { NoteList } from "../notes/NoteCard";
import { QuickNote } from "../notes/QuickNote";
import { useAppStore } from "../store/useAppStore";
import { useChatStore } from "../store/useChatStore";
import { notesInRange, notesOnFile, notesOnScope, useNotes } from "../store/useNotesStore";
import { ResizablePanelHandle, useResizablePanel } from "./ResizablePanelHandle";
import { TabStrip } from "./TabStrip";

const DocMarkdown = lazy(() => import("../ui/ChatMarkdown").then((module) => ({ default: module.DocMarkdown })));

type Tab = "overview" | "params" | "pseudocode" | "source" | "relations" | "notes";

const TAB_LABELS: Record<Tab, string> = {
  overview: msg("概览"),
  params: msg("传参"),
  pseudocode: msg("伪代码"),
  source: msg("源码"),
  relations: msg("关系"),
  notes: msg("笔记"),
};

/** Switching between tabs: Pseudocode steps 'Locate in source code', 'View pseudocode' in the overview */
interface TabNavigation {
  tab: Tab;
  setTab: (tab: Tab) => void;
  sourceFocus: SourceFocus | null;
  jumpToSource: (lines: [number, number]) => void;
  /** Calculate the details of each type yourself and attach the notes to it; the tab shows the number of items */
  setNoteCount: (count: number) => void;
}

/**
 * Right sidebar: The top shows details, and the bottom docks the follow-up question AI.
 *
 * The tab separation is the direct implementation of the 'hide' strategy: by default, only the overview, source code, and relationships are loaded.
 * This type of heavy query only sends a request when the user opens the corresponding tab. When there are no selected items but the dialog is open,
 * The conversation occupies the entire sidebar.
 */
export function DetailDrawer() {
  const t = useT();
  const open = useAppStore((s) => s.drawerOpen);
  const selected = useAppStore((s) => s.selected);
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const detailRequest = useAppStore((s) => s.detailRequest);
  const [tab, setTab] = useState<Tab>("overview");
  const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
  const [noteCount, setNoteCount] = useState(0);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const detailVisible = open && selected !== null;
  const resize = useResizablePanel({
    side: "right",
    visible: detailVisible || chatOpen,
    storageKey: "repolens:right-panel-custom-width",
    fallbackWidth: 400,
    minWidth: 320,
    maxWidth: 800,
  });

  const jumpToSource = (lines: [number, number]) => {
    setSourceFocus((current) => ({ lines, nonce: (current?.nonce ?? 0) + 1 }));
    setTab("source");
  };

  useEffect(() => {
    setTab(selected?.startsWith("raw:") ? "source" : "overview");
    setSourceFocus(null);
    setNoteCount(0);
  }, [selected]);

  // Must come after the reset above: when both the selected item and the request arrive at the same time, the request's tab takes precedence
  useEffect(() => {
    if (detailRequest === null || detailRequest.nodeId !== selected) return;
    useAppStore.getState().clearDetailRequest();
    if (detailRequest.lines) jumpToSource(detailRequest.lines);
    else setTab(detailRequest.tab);
  }, [selected, detailRequest]);
  if (!detailVisible && !chatOpen) return null;

  const isSymbol = selected?.startsWith("sym:") ?? false;
  const isFile = selected?.startsWith("file:") ?? false;
  // Files not indexed: No symbols, summaries, or relationships, only the original text
  const isRaw = selected?.startsWith("raw:") ?? false;
  // One edge on the diagram: see what it is made of
  const edge = parseEdgeSelection(selected);
  const availableTabs: Tab[] = isSymbol
    ? ["overview", "params", "pseudocode", "source", "relations", "notes"]
    : isFile
      ? ["overview", "pseudocode", "source", "relations", "notes"]
      : isRaw
        ? ["source"]
        : /^(?:dir|pkg):/.test(selected ?? "") ? ["overview", "notes"] : ["overview"];

  const navigation: TabNavigation = { tab, setTab, sourceFocus, jumpToSource, setNoteCount };

  return (
    <aside
      className="anim-slide-right absolute right-0 top-0 z-30 flex h-full flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur"
      style={{ width: resize.width }}
    >
      <ResizablePanelHandle
        side="right"
        label={t("调整右侧边栏宽度")}
        width={resize.width}
        minWidth={resize.minWidth}
        maxWidth={resize.maxWidth}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onReset={resize.reset}
      />
      {detailVisible && selected !== null && (
        <>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] pl-3 pr-2">
            <TabStrip scrollKey={`${selected}:${tab}`}>
              {availableTabs.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tab === key}
                  onClick={() => setTab(key)}
                  className={`shrink-0 rounded px-2 py-1 text-[11.5px] transition-colors ${
                    tab === key
                      ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                      : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
                  }`}
                >
                  {t(TAB_LABELS[key])}
                  {key === "notes" && noteCount > 0 && (
                    <span className="ml-1 tabular-nums text-[var(--color-note)]">{noteCount}</span>
                  )}
                </button>
              ))}
            </TabStrip>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label={t("关闭详情")}
              className="shrink-0 px-1 text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              ×
            </button>
          </div>

          <div ref={setContent} className="thin-scroll min-h-0 flex-1 overflow-y-auto">
            {isSymbol && <SymbolBody key={selected} id={selected} navigation={navigation} />}
            {isFile && <FileBody key={selected} id={selected} navigation={navigation} />}
            {isRaw && <RawFileBody key={selected} path={selected.slice(4)} focus={navigation.sourceFocus} />}
            {edge && <EdgeBody key={selected} from={edge.from} to={edge.to} />}
            {!isSymbol && !isFile && !isRaw && !edge && <ScopeBody key={selected} id={selected} navigation={navigation} />}
          </div>
          {!isRaw && !edge && <SelectionAsk container={content} nodeId={selected} />}
        </>
      )}
      <ChatDock detailVisible={detailVisible} />
    </aside>
  );
}

/** Add a step of pseudocode into the conversation as a quote; if line numbers are included, refer to the source file, and the server will attach those lines of the original text. */
function askAboutStep(quote: StepQuote, fileId: string, nodeId: string): void {
  const lines = quote.lines;
  useChatStore.getState().attach({
    key: `step:${nodeId}:${quote.text}`,
    kind: "quote",
    text: quote.text,
    nodeId: lines ? fileId : nodeId,
    lines,
    label: `${lines ? `L${lines[0]}${lines[1] === lines[0] ? "" : `–${lines[1]}`} · ` : ""}${quote.label.slice(0, 18)}`,
  });
}

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

function SymbolBody({ id, navigation }: { id: string; navigation: TabNavigation }) {
  const t = useT();
  const { tab } = navigation;
  const rememberLabel = useChatStore((s) => s.rememberLabel);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [detail, setDetail] = useState<SymbolDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);

  // Components are replaced with a new instance when switching nodes according to the selected item key; when the index is refreshed, the original content is retrieved in place and kept until the new content arrives, avoiding flashing into a skeleton screen.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSemanticLoading(false);
    setSemanticError(null);
    void api
      .symbol(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        rememberLabel(d.id, d.container ? `${d.container}.${d.name}` : d.name);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, rememberLabel, indexRevision]);

  const generateSemantics = (refresh = false) => {
    if (semanticLoading) return;
    setSemanticLoading(true);
    setSemanticError(null);
    void api
      .generateSymbolSemantics(id, refresh)
      .then((result) => {
        setDetail((current) =>
          current?.id === id
            ? {
                ...current, summary: result.summary, shortSummary: result.shortSummary ?? null,
                pseudocode: result.pseudocode ?? null, pseudocodeSteps: result.pseudocodeSteps ?? null,
              }
            : current,
        );
      })
      .catch((e: Error) => setSemanticError(e.message))
      .finally(() => setSemanticLoading(false));
  };

  // The summary and pseudocode are generated at the same time: when opening the Overview or Pseudocode tab, they are completed together and then read from the cache.
  useEffect(() => {
    if (
      (tab !== "overview" && tab !== "pseudocode") || detail === null ||
      (detail.summary && detail.shortSummary && detail.pseudocode) ||
      semanticLoading || semanticError
    ) return;
    generateSemantics();
  }, [tab, detail, semanticLoading, semanticError]);

  const allNotes = useNotes();
  const notes = useMemo(
    () => (detail ? notesInRange(allNotes, detail.filePath, detail.startLine, detail.endLine) : []),
    [allNotes, detail],
  );
  useNoteCount(navigation, notes.length);

  if (error) return <Empty>{error}</Empty>;
  if (!detail) return <Skeleton />;

  if (tab === "notes") return <NotesTab notes={notes} navigation={navigation} showPath={false} nodeId={id} />;

  if (tab === "pseudocode") {
    return (
      <PseudocodePanel
        steps={detail.pseudocodeSteps ?? null}
        fileId={detail.fileId}
        from={detail.startLine}
        to={detail.endLine}
        loading={semanticLoading}
        error={semanticError}
        loadingLabel={t("正在理解这个符号并生成伪代码…")}
        onGenerate={generateSemantics}
        onJumpToSource={navigation.jumpToSource}
        onAsk={(quote) => askAboutStep(quote, detail.fileId, detail.id)}
      />
    );
  }

  if (tab === "params") {
    return (
      <div className="p-3">
        {detail.params.length === 0 ? (
          <Empty>{t("这个符号没有参数")}</Empty>
        ) : (
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="text-left text-[var(--color-ink-faint)]">
                <th className="pb-1.5 font-normal">{t("参数")}</th>
                <th className="pb-1.5 font-normal">{t("类型")}</th>
                <th className="pb-1.5 font-normal">{t("默认值")}</th>
              </tr>
            </thead>
            <tbody>
              {detail.params.map((param) => (
                <tr key={param.name} className="border-t border-[var(--color-line)]">
                  <td className="mono py-1.5 pr-2 align-top text-[var(--color-ink)]">
                    {param.variadic && <span className="text-[var(--color-ink-faint)]">…</span>}
                    {param.name}
                    {param.optional && <span className="text-[var(--color-ink-faint)]">?</span>}
                  </td>
                  <td className="mono py-1.5 pr-2 align-top text-[var(--color-accent)]">
                    {param.type ?? "—"}
                  </td>
                  <td className="mono py-1.5 align-top text-[var(--color-ink-faint)]">
                    {param.defaultValue ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {detail.returnType && (
          <div className="mt-3 border-t border-[var(--color-line)] pt-2.5">
            <Label>{t("返回")}</Label>
            <div className="mono mt-1 text-[11.5px] text-[var(--color-accent)]">
              {detail.returnType}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (tab === "source") {
    return (
      <SourcePanel
        fileId={detail.fileId}
        from={detail.startLine}
        to={detail.endLine}
        steps={detail.pseudocodeSteps}
        focus={navigation.sourceFocus}
        notes={notes}
      />
    );
  }

  if (tab === "relations") {
    return (
      <div className="p-3">
        <CallGraphButton detail={detail} />
        <RelationList title={t("调用它的")} items={detail.callers} />
        <RelationList title={t("它调用的")} items={detail.callees} atDefinition />

        {detail.externalCallees.length > 0 && (
          <div className="mt-3">
            <Label>{t("外部调用")}</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {detail.externalCallees.map((ext) => (
                <span
                  key={ext.name}
                  className="mono rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-ink-faint)]"
                >
                  {ext.name} ×{ext.count}
                </span>
              ))}
            </div>
          </div>
        )}

        {detail.callers.length === 0 &&
          detail.callees.length === 0 &&
          detail.externalCallees.length === 0 && (
            <Empty>{t("没有解析出调用关系。可能它只被动态调用，或者调用方都在索引范围之外。")}</Empty>
          )}
      </div>
    );
  }

  const accent = languageColor(detail.language);

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span className="mono text-[13px]" style={{ color: accent }}>
          {symbolGlyph(detail.kind)}
        </span>
        <span className="truncate text-[14px] font-medium">
          {detail.container ? `${detail.container}.${detail.name}` : detail.name}
        </span>
        {detail.exported && (
          <span className="shrink-0 rounded border border-[var(--color-line)] px-1 text-[9.5px] text-[var(--color-ink-faint)]">
            exported
          </span>
        )}
      </div>

      <div className="mt-1 flex items-baseline gap-2">
        <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-ink-faint)]">
          {detail.filePath}:{detail.startLine}
        </span>
        <WalkLink detail={detail} />
      </div>
      {detail.testKind && (
        <div className="mt-2 text-[10.5px] text-[var(--color-ink-faint)]">
          <Chip tone="accent">{detail.testKind === "case" ? t("测试用例") : t("测试用例组")}</Chip>{" "}
          {t("标题是人写下的预期行为；单步走读能看到它实际调了什么")}
        </div>
      )}

      {detail.signature && (
        <DeclarationHeader
          key={detail.id}
          fileId={detail.fileId}
          startLine={detail.startLine}
          endLine={detail.endLine}
          signature={detail.signature}
          path={detail.filePath}
          language={detail.language}
        />
      )}

      {detail.doc && (
        <div className="mt-2.5">
          <Label>{t("文档注释")}</Label>
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.doc}
          </p>
        </div>
      )}

      {detail.summary ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label ai>{t("AI 摘要")}</Label>
            <SemanticRefreshButton loading={semanticLoading} onClick={() => generateSemantics(true)} />
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            <Grounded text={detail.summary} grounding={detail.grounding} />
          </p>
          <MissingNames count={missingCount(detail.grounding)} />
          {semanticError && (
            <div className="mt-2 text-[11px] text-[var(--color-warn)]">{t("刷新失败：{error}", { error: semanticError })}</div>
          )}
          <PseudocodeLink steps={detail.pseudocodeSteps} onOpen={() => navigation.setTab("pseudocode")} />
        </div>
      ) : semanticLoading ? (
        <SemanticLoading label={t("正在生成函数摘要与伪代码…")} />
      ) : semanticError ? (
        <div className="mt-2">
          <div className="text-[11px] text-[var(--color-warn)]">{semanticError}</div>
          <RetryButton onClick={generateSemantics}>{t("重试")}</RetryButton>
        </div>
      ) : (
        <RetryButton onClick={generateSemantics}>{t("生成 AI 摘要与伪代码")}</RetryButton>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label={t("行数")} value={String(detail.endLine - detail.startLine + 1)} />
        <Metric label={t("复杂度")} value={String(detail.complexity)} />
        <Metric label={t("种类")} value={detail.kind} />
      </div>

      {detail.typeRelations.length > 0 && (
        <div className="mt-3">
          <Label>{t("类型关系")}</Label>
          <div className="mt-1.5 space-y-1">
            {detail.typeRelations.map((rel, i) => (
              <div key={`${rel.relation}-${rel.target}-${i}`} className="text-[11.5px]">
                <span className="text-[var(--color-ink-faint)]">{rel.relation}</span>{" "}
                <span className="mono text-[var(--color-ink)]">{rel.target}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(detail.kind === "function" || detail.kind === "method") && !detail.testKind && (
        <SymbolTests nodeId={detail.id} coverage={detail.tests} />
      )}
      {isTypeKind(detail.kind) && <TypeFlowSection nodeId={detail.id} />}
    </div>
  );
}

/** A name mentioned in AI text but not found in the code */
function MissingNames({ count }: { count: number }) {
  const t = useT();
  if (count === 0) return null;
  return (
    <div className="mt-1.5 text-[10.5px] text-[var(--color-danger)]">
      {t("有 {count} 个名字在代码里找不到，可能是模型编的，以代码为准", { count })}
    </div>
  );
}

/** Start stepping through this function; classes and constants don't have function bodies to step through. */
function WalkLink({ detail }: { detail: SymbolDetailDto }) {
  const t = useT();
  const openWalk = useAppStore((s) => s.openWalk);
  if (detail.kind !== "function" && detail.kind !== "method") return null;
  return (
    <button
      type="button"
      onClick={() => openWalk(detail.id, detail.container ? `${detail.container}.${detail.name}` : detail.name)}
      title={t("沿它体内的调用一步步往下看，可以跨文件步入")}
      className="shrink-0 text-[10.5px] text-[var(--color-accent)] underline-offset-2 hover:underline"
    >
      {t("单步走读")} →
    </button>
  );
}

/** Center the current symbol on the call graph on the canvas */
function CallGraphButton({ detail }: { detail: SymbolDetailDto }) {
  const t = useT();
  const openCallGraph = useAppStore((s) => s.openCallGraph);
  const label = detail.container ? `${detail.container}.${detail.name}` : detail.name;
  const total = detail.callers.length + detail.callees.length;
  if (total === 0) return null;

  return (
    <button
      type="button"
      onClick={() => void openCallGraph(Number(detail.id.slice("sym:".length)), label)}
      className="mb-3 w-full rounded border border-[var(--color-line-strong)] px-2 py-1.5 text-[11.5px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
    >
      {t("在画布上展开调用图")}
    </button>
  );
}

/**
 * The caller shows which line in its file the call occurred; the callee shows where it is defined.
 * The calling line belongs to the file of the current symbol, and when combined with the other party's filename, it is a non-existent location.
 */
function RelationList({
  title,
  items,
  atDefinition = false,
}: {
  title: string;
  items: SymbolDetailDto["callers"];
  atDefinition?: boolean;
}) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  if (items.length === 0) return null;

  return (
    <div className="mb-3">
      <Label>
        {title} ({items.length})
      </Label>
      <div className="mt-1.5 space-y-0.5">
        {items.map((item) => (
          <div key={`${item.id}-${item.line}`}>
            <button
              type="button"
              onClick={() => select(item.id)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-2)]"
            >
              <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">
                {item.rendered ? `<${item.name} />` : item.name}
              </span>
              {item.http && (
                <span
                  title={t("前端请求按 URL 对上的后端路由，没有 import 证据")}
                  className="mono shrink-0 rounded border border-[var(--color-warn)]/40 px-1 text-[9.5px] text-[var(--color-warn)]"
                >
                  HTTP
                </span>
              )}
              <ConfidenceBadge value={item.confidence} />
              <span className="mono ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                {item.path.split("/").at(-1)}:{atDefinition ? item.definedAt : item.line}
              </span>
            </button>

            {/*
              多义关系必须把其他候选摊开。只显示一个猜出来的目标，
              等于把「同名的有 5 个，我挑了第一个」讲成了确定的事实。
            */}
            {item.candidates && item.candidates.length > 1 && (
              <div className="ml-1.5 border-l border-[var(--color-line)] pl-2">
                {item.candidates.map((cand) => (
                  <button
                    key={cand.id}
                    type="button"
                    onClick={() => select(cand.id)}
                    className="mono block w-full truncate-start truncate py-0.5 text-left text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
                  >
                    {cand.path}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: string }) {
  const t = useT();
  const styles: Record<string, string> = {
    exact: "border-[var(--color-accent)]/40 text-[var(--color-accent)]",
    likely: "border-[var(--color-warn)]/40 text-[var(--color-warn)]",
    ambiguous: "border-[var(--color-line-strong)] text-[var(--color-ink-faint)]",
    external: "border-[var(--color-line)] text-[var(--color-ink-faint)]",
    unresolved: "border-[var(--color-line)] text-[var(--color-ink-faint)]",
  };
  const labels: Record<string, string> = {
    exact: t("确定"),
    likely: t("可能"),
    ambiguous: t("多义"),
    external: t("外部"),
    unresolved: t("未解析"),
  };
  return (
    <span
      className={`shrink-0 rounded border px-1 text-[9.5px] ${styles[value] ?? styles["unresolved"]}`}
    >
      {labels[value] ?? value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

function FileBody({ id, navigation }: { id: string; navigation: TabNavigation }) {
  const t = useT();
  const { tab } = navigation;
  const select = useAppStore((s) => s.select);
  const rememberLabel = useChatStore((s) => s.rememberLabel);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [detail, setDetail] = useState<FileDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [semanticSkipReason, setSemanticSkipReason] = useState<"empty-file" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSemanticLoading(false);
    setSemanticError(null);
    setSemanticSkipReason(null);
    void api
      .file(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        rememberLabel(d.id, d.path.split("/").at(-1) ?? d.path);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, rememberLabel, indexRevision]);

  const generateSummary = (refresh = false) => {
    if (semanticLoading) return;
    setSemanticLoading(true);
    setSemanticError(null);
    void api
      .generateFileSummary(id, refresh)
      .then((result) => {
        setSemanticSkipReason(result.skipReason ?? null);
        setDetail((current) => (current?.id === id
          ? {
              ...current, summary: result.summary, shortSummary: result.shortSummary ?? null,
              pseudocode: result.pseudocode ?? null, pseudocodeSteps: result.pseudocodeSteps ?? null,
            }
          : current));
      })
      .catch((e: Error) => setSemanticError(e.message))
      .finally(() => setSemanticLoading(false));
  };

  // The semantics of the document are a whole: if any item is missing—summary, single-sentence tooltip, or document pseudocode—it should be completed.
  // Files that are not involved in the analysis (tests, configurations, documents, etc.) are mostly just for viewing the original text and will be generated when the user requests them.
  useEffect(() => {
    if (
      detail === null || detail.role !== "source" ||
      detail.bytes === 0 || semanticSkipReason === "empty-file" ||
      (detail.summary && detail.shortSummary && detail.pseudocode) ||
      semanticLoading || semanticError
    ) return;
    generateSummary();
  }, [detail, semanticLoading, semanticError, semanticSkipReason]);

  const allNotes = useNotes();
  const notes = useMemo(() => (detail ? notesOnFile(allNotes, detail.path) : []), [allNotes, detail]);
  useNoteCount(navigation, notes.length);

  if (error) return <Empty>{error}</Empty>;
  if (!detail) return <Skeleton />;

  if (tab === "notes") return <NotesTab notes={notes} navigation={navigation} showPath={false} nodeId={id} />;

  const empty = detail.bytes === 0 || semanticSkipReason === "empty-file";

  if (tab === "pseudocode") {
    if (empty) return <Empty>{t("空文件，没有可生成的伪代码")}</Empty>;
    return (
      <PseudocodePanel
        steps={detail.pseudocodeSteps ?? null}
        fileId={detail.id}
        loading={semanticLoading}
        error={semanticError}
        loadingLabel={t("正在分析文件内函数与整体逻辑…")}
        onGenerate={generateSummary}
        onJumpToSource={navigation.jumpToSource}
        onAsk={(quote) => askAboutStep(quote, detail.id, detail.id)}
      />
    );
  }

  if (tab === "source") {
    return (
      <SourcePanel fileId={detail.id} steps={detail.pseudocodeSteps} focus={navigation.sourceFocus} notes={notes} />
    );
  }

  if (tab === "relations") {
    return (
      <div className="p-3">
        <Label>{t("依赖 ({count})", { count: detail.imports.length })}</Label>
        <div className="mt-1.5 space-y-0.5">
          {detail.imports.map((imp, i) => (
            <div
              key={`${imp.source}-${imp.line}-${i}`}
              className="flex items-center gap-2 rounded px-1.5 py-1 text-[11.5px]"
            >
              <span className="mono truncate text-[var(--color-ink)]">{imp.source}</span>
              <ConfidenceBadge value={imp.confidence} />
              {imp.targetPath && (
                <span className="mono ml-auto shrink-0 truncate text-[10px] text-[var(--color-ink-faint)]">
                  {imp.targetPath}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3">
          <Label>{t("被依赖 ({count})", { count: detail.importedBy.length })}</Label>
          <div className="mt-1.5 space-y-0.5">
            {detail.importedBy.map((ref) => (
              <button
                key={ref.id}
                type="button"
                onClick={() => select(ref.id)}
                className="mono block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-2)]"
              >
                {ref.path}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: languageColor(detail.language) }}
        />
        <span className="truncate text-[14px] font-medium">{detail.path.split("/").at(-1)}</span>
      </div>
      <div className="mono mt-1 break-all text-[10.5px] text-[var(--color-ink-faint)]">
        {detail.path}
      </div>

      {detail.parseError && (
        <div className="mt-2 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/5 px-2 py-1.5 text-[11px] text-[var(--color-warn)]">
          {detail.parseError}
        </div>
      )}

      {empty ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2.5 text-[11.5px] text-[var(--color-ink-faint)]">
          {t("空文件，没有可生成的内容")}
        </div>
      ) : detail.summary ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label ai>{t("AI 摘要")}</Label>
            <SemanticRefreshButton loading={semanticLoading} onClick={() => generateSummary(true)} />
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            <Grounded text={detail.summary} grounding={detail.grounding} />
          </p>
          <MissingNames count={missingCount(detail.grounding)} />
          {semanticError && (
            <div className="mt-2 text-[11px] text-[var(--color-warn)]">{t("刷新失败：{error}", { error: semanticError })}</div>
          )}
          <PseudocodeLink steps={detail.pseudocodeSteps} onOpen={() => navigation.setTab("pseudocode")} />
        </div>
      ) : detail.role !== "source" && !semanticLoading && !semanticError ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2.5">
          <p className="text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
            {t("这个文件不参与分析，需要时再让 AI 解读。")}
          </p>
          <RetryButton onClick={generateSummary}>{t("生成 AI 摘要与伪代码")}</RetryButton>
        </div>
      ) : semanticLoading || !semanticError ? (
        <SemanticLoading label={t("正在生成文件摘要与伪代码…")} />
      ) : semanticError ? (
        <div className="mt-2">
          <div className="text-[11px] text-[var(--color-warn)]">{semanticError}</div>
          <RetryButton onClick={generateSummary}>{t("重试")}</RetryButton>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label={t("代码行")} value={formatCount(detail.loc)} />
        <Metric label={t("符号数")} value={String(detail.symbols.length)} />
        <Metric label={t("依赖")} value={String(detail.imports.length)} />
        <Metric label={t("被依赖")} value={String(detail.importedBy.length)} />
      </div>

      <ScopeTests nodeId={detail.id} tests={detail.tests} />
      <HistorySection history={detail.history} />

      <div className="mt-3">
        <Label>{t("符号 ({count})", { count: detail.symbols.length })}</Label>
        <div className="mt-1.5 space-y-0.5">
          {detail.symbols.map((sym) => (
            <button
              key={sym.id}
              type="button"
              onClick={() => select(sym.id)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-2)]"
            >
              <span
                className="mono w-3 shrink-0 text-[10px]"
                style={{ color: languageColor(detail.language) }}
              >
                {symbolGlyph(sym.kind)}
              </span>
              <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">
                {sym.container ? `${sym.container}.${sym.name}` : sym.name}
              </span>
              {!sym.exported && (
                <span className="shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{t("内部")}</span>
              )}
              <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
                {sym.startLine}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function RawFileBody({ path, focus }: { path: string; focus: SourceFocus | null }) {
  const t = useT();
  return (
    <>
      <div className="border-b border-[var(--color-line)] px-3 py-2">
        <div className="mono break-all text-[11px] text-[var(--color-ink-muted)]">{path}</div>
        <div className="mt-0.5 text-[10.5px] text-[var(--color-ink-faint)]">{t("没进索引，不参与分析，这里只显示原文")}</div>
      </div>
      <SourcePanel fileId={`raw:${path}`} focus={focus} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Package / Directory / Aggregate
// ---------------------------------------------------------------------------

function ScopeBody({ id, navigation }: { id: string; navigation: TabNavigation }) {
  const t = useT();
  const store = useAppStore();
  const allNotes = useNotes();
  const notes = useMemo(() => notesOnScope(allNotes, id), [allNotes, id]);
  useNoteCount(navigation, notes.length);
  const readme = useReadme(id);
  const graph = store.subgraphs[store.rootScope];
  const node =
    Object.values(store.subgraphs)
      .flatMap((g) => g.nodes)
      .find((n) => n.id === id) ?? graph?.nodes.find((n) => n.id === id);

  if (navigation.tab === "notes") return <NotesTab notes={notes} navigation={navigation} showPath nodeId={id} />;
  // The root of the warehouse is not a node on the diagram; enter from the warehouse name at the top of the structure tree.
  if (!node && id === store.rootScope) return <RepoRootBody readme={readme} />;
  if (!node) return <Empty>{t("找不到这个节点")}</Empty>;

  return (
    <div className="p-3">
      <div className="text-[14px] font-medium">{node.label}</div>
      {node.path && (
        <div className="mono mt-1 break-all text-[10.5px] text-[var(--color-ink-faint)]">
          {node.path}
        </div>
      )}

      {node.layer && !/^(?:dir|pkg):/.test(node.id) && (
        <div className="mt-2 text-[10px] text-[var(--color-accent)]">{t("AI 架构层 · {layer}", { layer: node.layer })}</div>
      )}
      {node.summary && (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <Label ai>{t("AI 摘要")}</Label>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">{node.summary}</p>
        </div>
      )}
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label={t("代码行")} value={formatCount(node.metrics.loc)} />
        <Metric label={t("文件数")} value={formatCount(node.metrics.files)} />
        <Metric label={t("符号数")} value={formatCount(node.metrics.symbols)} />
        <Metric label={t("复杂度")} value={formatCount(node.metrics.complexity)} />
        <Metric label={t("依赖")} value={String(node.metrics.outDegree)} />
        <Metric label={t("被依赖")} value={String(node.metrics.inDegree)} />
      </div>

      {node.expandable && (
        <button
          type="button"
          onClick={() => void store.toggleExpand(node)}
          className="mt-3 w-full rounded-md border border-[var(--color-line)] py-1.5 text-[11.5px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
        >
          {store.expanded.includes(node.id) ? t("收起子项") : t("展开 {count} 项", { count: node.childCount })}
        </button>
      )}

      {/^(?:dir|pkg):/.test(node.id) && <ModuleCardSection nodeId={node.id} />}
      {readme && <ReadmeSection readme={readme} />}
    </div>
  );
}

function RepoRootBody({ readme }: { readme: ReadmeDto | null }) {
  const t = useT();
  const overview = useAppStore((s) => s.overview);
  if (!overview) return <Skeleton />;

  return (
    <div className="p-3">
      <div className="text-[14px] font-medium">{overview.repoName}</div>
      <div className="mono mt-1 break-all text-[10.5px] text-[var(--color-ink-faint)]">{overview.repoRoot}</div>

      {overview.summary && (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <Label ai>{t("AI 仓库概览")}</Label>
          <p className="mt-1 whitespace-pre-line text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {overview.summary}
          </p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label={t("源码行")} value={formatCount(overview.totals.sourceLoc)} />
        <Metric label={t("源码文件")} value={formatCount(overview.totals.sourceFiles)} />
        <Metric label={t("符号数")} value={formatCount(overview.totals.symbols)} />
        <Metric label={t("包数")} value={String(overview.totals.packages)} />
      </div>
      <p className="mt-1 text-[10.5px] text-[var(--color-ink-faint)]">
        {t("连同测试、文档、配置共 {loc} 行、{files} 个文件", { loc: formatCount(overview.totals.loc), files: formatCount(overview.totals.files) })}
        {overview.history && overview.history.commits > 0 && (
          <> · {t("近一年 {commits} 次提交，{ai} 次标明有 AI 参与", { commits: overview.history.commits, ai: overview.history.aiCommits })}</>
        )}
      </p>

      <ConventionsSection overview={overview} />
      <SkeletonSection />
      {readme && <ReadmeSection readme={readme} />}
    </div>
  );
}

function useReadme(id: string): ReadmeDto | null {
  const repoRevision = useAppStore((s) => `${s.repoRevision}.${s.indexRevision}`);
  const [readme, setReadme] = useState<ReadmeDto | null>(null);
  useEffect(() => {
    if (!/^(?:dir|pkg):/.test(id)) return;
    let cancelled = false;
    setReadme(null);
    // README is just supplementary; if it can't be retrieved, it won't be displayed and won't interrupt the overview.
    void api.readme(id).then((result) => !cancelled && setReadme(result)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, repoRevision]);
  return readme;
}

function ReadmeSection({ readme }: { readme: ReadmeDto }) {
  const t = useT();
  const openDetail = useAppStore((s) => s.openDetail);

  const plain = (
    <pre className="whitespace-pre-wrap break-words font-[inherit] text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
      {readme.content}
    </pre>
  );

  return (
    <section className="mt-3 border-t border-[var(--color-line)] pt-2.5">
      <div className="flex items-center gap-2">
        <Label>README</Label>
        <button
          type="button"
          onClick={() => openDetail(readme.fileId, { tab: "source", lines: null }, false)}
          title={t("在源码中打开")}
          className="mono ml-auto min-w-0 truncate text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-accent)]"
        >
          {readme.path.split("/").at(-1)}
        </button>
      </div>
      <div className="mt-1.5">
        {readme.format === "markdown" ? (
          <Suspense fallback={plain}>
            <DocMarkdown content={readme.content} />
          </Suspense>
        ) : (
          plain
        )}
      </div>
      {readme.truncated && (
        <p className="mt-1 text-[10.5px] text-[var(--color-ink-faint)]">
          {t("README 太长，这里只显示开头部分，完整内容点上面的文件名在源码里看")}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

function useNoteCount(navigation: TabNavigation, count: number): void {
  const { setNoteCount } = navigation;
  useEffect(() => setNoteCount(count), [setNoteCount, count]);
}

/** In files and symbols, the position of the note scrolls the source code in place; notes in the directory are scattered across various files and need to be jumped to. */
function NotesTab({ notes, navigation, showPath, nodeId }: { notes: NoteDto[]; navigation: TabNavigation; showPath: boolean; nodeId: string }) {
  const t = useT();
  return (
    <div className="p-3">
      <QuickNote nodeId={nodeId} />
      <NoteList
        notes={notes}
        showPath={showPath}
        empty={t("还没有笔记。直接在上面写，或在追问 AI 的回答里划选文字、点「记笔记」。")}
        onLocate={showPath ? undefined : (note) => {
          const lines = note.target.kind === "file" ? note.target.lines : null;
          return lines ? () => navigation.jumpToSource(lines) : null;
        }}
      />
    </div>
  );
}

function SemanticLoading({ label }: { label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5 px-2.5 py-2 text-[11px] text-[var(--color-ink-muted)]">
      <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
      {label}
    </div>
  );
}

/** Pseudocode has its own tab, and the overview only leaves one entry line, listing the first two steps to let people know if it's worth opening. */
/** The overview only lists the top-level steps, one per line, as an outline; the sub-steps and source code correspondence are left for the pseudocode section. */
function PseudocodeLink({ steps, onOpen }: { steps: PseudocodeStepDto[] | null | undefined; onOpen: () => void }) {
  const t = useT();
  if (!steps || steps.length === 0) return null;
  const markerWidth = stepMarkerWidth(steps.length);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("查看完整伪代码")}
      className="group mt-2.5 block w-full border-t border-[var(--color-accent)]/20 pt-2 text-left"
    >
      <span className="flex items-baseline">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-accent)]">{t("伪代码 {count} 步", { count: steps.length })}</span>
        <span className="ml-auto text-[11px] text-[var(--color-ink-faint)] group-hover:text-[var(--color-accent)]">→</span>
      </span>
      <span className="mt-1 block space-y-0.5">
        {steps.map((step, index) => (
          <span key={index} className="flex items-baseline gap-1.5">
            <span className={`mono ${markerWidth} shrink-0 text-[10.5px] tabular-nums text-[var(--color-accent)]`}>
              {index + 1}
            </span>
            <span className="truncate text-[11px] text-[var(--color-ink-muted)]">{step.text}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

function SemanticRefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      aria-label={loading ? t("正在重新生成 AI 摘要") : t("重新生成 AI 摘要")}
      title={loading ? t("正在重新生成…") : t("重新生成 AI 摘要")}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[14px] leading-none text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
    >
      <span className={loading ? "animate-spin" : ""}>↻</span>
    </button>
  );
}

function RetryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 rounded border border-[var(--color-accent)]/40 px-2 py-1 text-[10.5px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10"
    >
      {children}
    </button>
  );
}
