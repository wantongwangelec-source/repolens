import type { Confidence, IoReachDto, WalkCallDto, WalkFrameDto, WalkTargetDto } from "@repolens/core/types";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useSource } from "../code/useSource";
import { msg, useT } from "../i18n";
import { useSidebarInset } from "../layout/ResizablePanelHandle";
import { useAppStore, type WalkFrameRef } from "../store/useAppStore";
import { CodeLine, type CodeMark } from "../ui/CodeLines";
import { IO_LABELS } from "../ui/visual";
import { buildSkeleton, displayBlocks, offMainPath, openedBlocks, walkable, type DisplayBlock, type Skeleton, type StepOptions } from "./skeleton";

const RESOLUTION_LABELS: Record<Confidence, string> = {
  exact: msg("确定"),
  likely: msg("可能"),
  ambiguous: msg("多义"),
  external: msg("外部"),
  unresolved: msg("未解析"),
};

function steppable(call: WalkCallDto | null): WalkTargetDto | null {
  return call && call.resolution !== "ambiguous" ? call.target ?? null : null;
}

/** For calls that can't be recorded in the warehouse, you need to clearly explain where they fall and why they can't be pushed out. Simply saying 'can't be determined' is equivalent to saying nothing at all. */
function callNote(call: WalkCallDto, t: ReturnType<typeof useT>): string | null {
  if (call.resolution === "external") {
    const name = call.external ?? call.callee;
    return call.builtin ? t("语言内置 {name}", { name }) : t("外部库 {name}", { name });
  }
  if (call.resolution !== "unresolved") return null;
  const reason = call.unresolved;
  switch (reason?.kind) {
    case "callback":
      return t("{name} 是参数传进来的函数，要看调用方传了什么", { name: call.callee });
    case "function-value":
      if (!reason.source) {
        return t("{name} 不是本文件定义或 import 的函数，可能来自闭包、变量或运行时注入", { name: call.callee });
      }
      return reason.destructured
        ? t("{name} 是从 {source} 的返回值里解构出来的函数，静态分析不追踪函数值", { name: call.callee, source: reason.source })
        : t("{name} 是 {source} 返回的函数，静态分析不追踪函数值", { name: call.callee, source: reason.source });
    case "chained":
      return t("接在上一个调用的返回值上，推不出这个返回值的类型");
    case "untyped": {
      const receiver = shorten(call.receiver ?? "");
      if (reason.source) return t("{receiver} 来自 {source} 的返回值，推不出它的类型", { receiver, source: reason.source });
      if (reason.param) return t("{receiver} 是没标类型的参数，推不出它的类型", { receiver });
      return t("推不出 {receiver} 的类型，多半是内置对象或外部库返回的数据", { receiver });
    }
    case "inherited":
      return t("类和父类里都没找到这个方法，可能是运行时挂上去的");
    default:
      return t("静态分析确定不了它调的是哪个函数");
  }
}

// ---------------------------------------------------------------------------
// Frame buffer: Stepping out and then back into the same function, or switching the display range back and forth, should not trigger a new request
// ---------------------------------------------------------------------------

const frameCache = new Map<string, Promise<WalkFrameDto>>();
const FRAME_CACHE_SIZE = 64;

function frameKey(id: string): string {
  const { repoId, repoRevision, indexRevision } = useAppStore.getState();
  return `${repoId ?? ""}:${repoRevision}.${indexRevision}:${id}`;
}

function loadFrame(id: string): Promise<WalkFrameDto> {
  const key = frameKey(id);
  const cached = frameCache.get(key);
  if (cached) return cached;
  const task = api.walk(id);
  frameCache.set(key, task);
  task.catch(() => frameCache.delete(key));
  if (frameCache.size > FRAME_CACHE_SIZE) {
    const oldest = frameCache.keys().next().value;
    if (oldest !== undefined) frameCache.delete(oldest);
  }
  return task;
}

function useWalkFrames(ids: readonly string[]): { frames: Map<string, WalkFrameDto>; error: string | null } {
  const [frames, setFrames] = useState(() => new Map<string, WalkFrameDto>());
  const [error, setError] = useState<string | null>(null);
  const joined = ids.join(",");
  // After the index is refreshed, the key of the frame cache changes, and what is retrieved is the function body after the modification.
  const indexRevision = useAppStore((s) => s.indexRevision);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    for (const id of joined.split(",")) {
      void loadFrame(id)
        .then((frame) => {
          if (cancelled) return;
          setFrames((current) => (current.get(id) === frame ? current : new Map(current).set(id, frame)));
        })
        .catch((err: Error) => !cancelled && setError(err.message));
    }
    return () => {
      cancelled = true;
    };
  }, [joined, indexRevision]);

  return { frames, error };
}

// ---------------------------------------------------------------------------
// Walkthrough view
// ---------------------------------------------------------------------------

/**
 * Step-by-step execution: look at one function at a time, stopping at each call within it in the order of execution,
 * You can step into the called function (even across files) and step out to return to the caller. The call stack is the path that has been taken.
 */
export function WalkView() {
  const t = useT();
  const walk = useAppStore((s) => s.walk);
  const allCalls = useAppStore((s) => s.walkAllCalls);
  const showTrivial = useAppStore((s) => s.walkShowTrivial);
  const mainPath = useAppStore((s) => s.walkMainPath);
  const setStack = useAppStore((s) => s.setWalkStack);
  const closeWalk = useAppStore((s) => s.closeWalk);
  const select = useAppStore((s) => s.select);
  const stack = walk?.stack ?? EMPTY_STACK;
  const top = stack.at(-1) ?? null;
  const { frames, error } = useWalkFrames(stack.map((ref) => ref.id));
  const frame = top ? frames.get(top.id) ?? null : null;

  const options = useMemo<StepOptions>(() => ({ all: allCalls, trivial: showTrivial, mainPath }), [allCalls, showTrivial, mainPath]);
  const skeleton = useMemo(() => (frame ? buildSkeleton(frame, options) : null), [frame, options]);
  const steps = skeleton?.steps ?? EMPTY_STEPS;
  const index = top ? steps.findIndex((call) => call.id === top.at) : -1;
  const current = index >= 0 ? steps[index] ?? null : null;
  const caller = stack.length > 1 ? stack[stack.length - 2] ?? null : null;

  // Just stepping in, stop at the first step; after the place where it stopped is filtered out, move to the nearest step behind it; after the index is refreshed, the call id changes, stop by line near the original place
  useEffect(() => {
    if (!frame || !top || frame.id !== top.id || index >= 0) return;
    let at: string | null = steps[0]?.id ?? null;
    if (top.at !== null) {
      const position = frame.calls.findIndex((call) => call.id === top.at);
      const visible = new Set(steps.map((call) => call.id));
      at = position >= 0
        ? frame.calls.slice(position + 1).find((call) => visible.has(call.id))?.id ?? steps.at(-1)?.id ?? null
        : steps.find((call) => call.line >= (top.line ?? 0))?.id ?? steps.at(-1)?.id ?? null;
    }
    if (at !== top.at || frame.name !== top.name) {
      setStack([...stack.slice(0, -1), { ...top, name: frame.name, at, line: lineOf(frame, at) }]);
    }
  }, [frame, top, index, steps, stack, setStack]);

  // Fetch the next frame before stepping in, no need to wait when pressing →
  const nextTarget = steppable(current);
  useEffect(() => {
    if (nextTarget) void loadFrame(nextTarget.id).catch(() => {});
  }, [nextTarget]);

  const actions = {
    goto(at: string) {
      if (top) setStack([...stack.slice(0, -1), { ...top, at, line: frame ? lineOf(frame, at) : null }]);
    },
    next() {
      const following = steps[index + 1];
      if (following) return actions.goto(following.id);
      // The function has finished: it returns to the caller like a debugger and proceeds to its next step
      if (!caller) return;
      const callerFrame = frames.get(caller.id);
      const callerSteps = callerFrame ? buildSkeleton(callerFrame, options).steps : [];
      const at = callerSteps[callerSteps.findIndex((call) => call.id === caller.at) + 1]?.id ?? caller.at;
      setStack([...stack.slice(0, -2), { ...caller, at, line: callerFrame ? lineOf(callerFrame, at) : caller.line ?? null }]);
    },
    prev() {
      const previous = steps[index - 1];
      if (previous) actions.goto(previous.id);
    },
    into(target: WalkTargetDto | null = nextTarget) {
      if (target) setStack([...stack, { id: target.id, name: target.name, at: null }]);
    },
    /** Passing through a function that only forwards: both frames go onto the stack, the call stack is accurate, but it stops directly in the function that actually does the work */
    through(target: WalkTargetDto) {
      const final = target.forwardsTo;
      if (!final) return actions.into(target);
      setStack([...stack, { id: target.id, name: target.name, at: null }, { id: final.id, name: final.name, at: null }]);
    },
    out(depth = stack.length - 2) {
      if (depth >= 0 && depth < stack.length - 1) setStack(stack.slice(0, depth + 1));
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const rootRef = useRef<HTMLDivElement>(null);
  const inset = { paddingLeft: useSidebarInset("left"), paddingRight: useSidebarInset("right") };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      // Only input boxes and controls like the sidebar width drag handle, which require using the arrow keys themselves, should have the keys reserved for them. Ordinary buttons in the sidebar
      // No need for the arrow keys; after clicking the entry, the focus still stays on that button, and the shortcut key for walkthroughs cannot be disabled because of this.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='separator'], [role='listbox']")) return;
      const run = actionsRef.current;
      const key = event.key;
      if (key === "ArrowDown" || key === "j" || key === "F10") run.next();
      else if (key === "ArrowUp" || key === "k") run.prev();
      else if ((key === "F11" && event.shiftKey) || key === "ArrowLeft" || key === "h") run.out();
      else if (key === "ArrowRight" || key === "l" || key === "F11") run.into();
      else return;
      event.preventDefault();
      // After pressing a key, the browser will draw a focus box around the sidebar button that still has focus, making it look like the arrow keys are selecting the sidebar.
      if (target && target !== document.body && !rootRef.current?.contains(target)) target.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!walk || !top) return null;
  if (error && !frame) {
    return (
      <div ref={rootRef} className="flex h-full flex-col bg-[var(--color-canvas)]" style={inset}>
        <WalkMessage>
          <div>{error}</div>
          <button type="button" onClick={stack.length > 1 ? () => actions.out() : closeWalk}
            className="mt-3 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] hover:border-[var(--color-line-strong)]">
            {stack.length > 1 ? t("步出") : t("返回结构图")}
          </button>
        </WalkMessage>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-[var(--color-canvas)]" style={inset}>
      <CallStack stack={stack} frames={frames} onOut={(depth) => actions.out(depth)} />

      {frame === null ? (
        <WalkMessage>{t("正在读取函数…")}</WalkMessage>
      ) : (
        <>
          <header className="flex shrink-0 items-start gap-4 border-b border-[var(--color-line)] px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <h1 className="mono truncate text-[14px] font-medium text-[var(--color-ink)]">{frame.name}</h1>
                <span className="mono truncate text-[10.5px] text-[var(--color-ink-faint)]">
                  {frame.filePath}:{frame.startLine}–{frame.endLine}
                </span>
              </div>
              {frame.summary && (
                <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">{frame.summary}</p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Reaches reaches={frame.reaches} />
                <button type="button" onClick={() => select(frame.id)}
                  className="text-[10.5px] text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline">
                  {t("查看详情")}
                </button>
              </div>
            </div>
            <StepButtons
              canPrev={index > 0}
              canNext={index < steps.length - 1 || caller !== null}
              canInto={nextTarget !== null}
              canOut={caller !== null}
              actions={actions}
            />
          </header>

          <div className="flex min-h-0 flex-1">
            <StepList
              frame={frame}
              skeleton={skeleton ?? EMPTY_SKELETON}
              current={current}
              options={options}
              caller={caller ? frames.get(caller.id)?.name ?? caller.name : null}
              onPick={actions.goto}
            />
            <FrameSource
              key={frame.id}
              frame={frame}
              steps={steps}
              repeats={skeleton?.repeats ?? EMPTY_SKELETON.repeats}
              current={current}
              stackIds={stack.map((ref) => ref.id)}
              onPick={actions.goto}
              onInto={actions.into}
              onThrough={actions.through}
            />
          </div>
        </>
      )}
    </div>
  );
}

const EMPTY_STACK: WalkFrameRef[] = [];
const EMPTY_STEPS: WalkCallDto[] = [];
const EMPTY_SKELETON: Skeleton = { steps: [], repeats: new Map(), folded: { trivial: 0, offPath: 0 } };

function lineOf(frame: WalkFrameDto, at: string | null): number | null {
  return at === null ? null : frame.calls.find((call) => call.id === at)?.line ?? null;
}

function WalkMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-[12px] text-[var(--color-ink-faint)]">
      {children}
    </div>
  );
}

/** The call stack starting from the entry point, step out to whichever frame you click on */
function CallStack({ stack, frames, onOut }: {
  stack: readonly WalkFrameRef[];
  frames: ReadonlyMap<string, WalkFrameDto>;
  onOut: (depth: number) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.scrollTo({ left: ref.current.scrollWidth });
  }, [stack.length]);

  return (
    <div ref={ref} className="thin-scroll flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3">
      <span className="mr-1 shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{t("调用栈")}</span>
      {stack.map((ref, depth) => {
        const frame = frames.get(ref.id);
        const last = depth === stack.length - 1;
        const file = frame?.filePath.split("/").at(-1);
        const crossFile = depth > 0 && frame && frames.get(stack[depth - 1]!.id)?.fileId !== frame.fileId;
        return (
          <Fragment key={`${depth}:${ref.id}`}>
            {depth > 0 && <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">›</span>}
            <button
              type="button"
              disabled={last}
              onClick={() => onOut(depth)}
              title={frame ? `${frame.filePath}:${frame.startLine}` : undefined}
              className={`flex max-w-72 shrink-0 items-baseline gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors ${
                last
                  ? "bg-[var(--color-accent)]/12 text-[var(--color-ink)]"
                  : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
              }`}
            >
              <span className="mono truncate text-[11px]">{frame?.name ?? ref.name}</span>
              {file && (
                <span className={`mono shrink-0 text-[9.5px] ${crossFile ? "text-[var(--color-accent)]" : "text-[var(--color-ink-faint)]"}`}>
                  {file}
                </span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function StepButtons({ canPrev, canNext, canInto, canOut, actions }: {
  canPrev: boolean; canNext: boolean; canInto: boolean; canOut: boolean;
  actions: { prev: () => void; next: () => void; into: () => void; out: () => void };
}) {
  const t = useT();
  const button = (label: string, key: string, enabled: boolean, run: () => void, title: string) => (
    <button type="button" disabled={!enabled} onClick={run} title={title}
      className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] transition-colors enabled:hover:border-[var(--color-line-strong)] enabled:hover:text-[var(--color-ink)] disabled:opacity-40">
      {label}
      <kbd className="mono rounded bg-[var(--color-surface-3)] px-1 text-[10px] text-[var(--color-ink-faint)]">{key}</kbd>
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {button(t("上一步"), "↑", canPrev, actions.prev, t("回到上一处调用"))}
      {button(t("下一步"), "↓", canNext, actions.next, t("跳过这次调用，停到下一处；函数走完时回到调用方"))}
      {button(t("步入"), "→", canInto, () => actions.into(), t("进入被调函数，跨文件也一样"))}
      {button(t("步出"), "←", canOut, () => actions.out(), t("回到调用方"))}
    </div>
  );
}

function Reaches({ reaches }: { reaches: readonly IoReachDto[] }) {
  const t = useT();
  return (
    <>
      {reaches.map((reach) => (
        <span key={reach.kind}
          title={reach.depth === 0
            ? t("自己就在访问{kind}", { kind: t(IO_LABELS[reach.kind]) })
            : t("往下最少 {count} 层调用会访问{kind}", { count: reach.depth, kind: t(IO_LABELS[reach.kind]) })}
          className="rounded border border-[var(--color-warn)]/35 px-1 text-[9.5px] text-[var(--color-warn)]">
          {t(IO_LABELS[reach.kind])}{reach.depth > 0 ? ` +${reach.depth}` : ""}
        </span>
      ))}
    </>
  );
}

/**
 * Step list grouped by control structure: it's clear at a glance which if/loop/try/callback it is in. Guard branches with early returns.
 * Dim it, repeatedly call the same function within the same block to synthesize into one line, and bypass calls like timing and logging are collapsed by default.
 */
function StepList({ frame, skeleton, current, options, caller, onPick }: {
  frame: WalkFrameDto;
  skeleton: Skeleton;
  current: WalkCallDto | null;
  options: StepOptions;
  caller: string | null;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const setAllCalls = useAppStore((s) => s.setWalkAllCalls);
  const setShowTrivial = useAppStore((s) => s.setWalkShowTrivial);
  const setMainPath = useAppStore((s) => s.setWalkMainPath);
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);
  const { steps, repeats, folded } = skeleton;
  const external = options.all ? 0 : frame.calls.filter((call) => !walkable(call)).length;
  const atEnd = current !== null && current === steps.at(-1);

  return (
    <aside className="thin-scroll flex w-72 shrink-0 flex-col overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-surface)] py-1.5">
      <div className="px-3 pb-1 text-[10px] text-[var(--color-ink-faint)]">
        {t("{count} 处调用，按执行顺序", { count: steps.length })}
      </div>
      {steps.map((call, i) => {
        const active = call === current;
        const target = call.target;
        const crossFile = target && target.fileId !== frame.fileId;
        const depth = displayBlocks(call).length;
        const more = repeats.get(call.id);
        const side = offMainPath(call);
        return (
          <Fragment key={call.id}>
            {openedBlocks(steps[i - 1] ?? null, call).map(({ block, depth: level }) => (
              <BlockHeader key={`${call.id}:${block.key}`} block={block} depth={level} />
            ))}
            <button
              ref={active ? currentRef : undefined}
              type="button"
              onClick={() => onPick(call.id)}
              className={`relative flex w-full items-baseline gap-2 py-1 pr-2.5 text-left transition-colors ${
                active ? "bg-[var(--color-surface-3)]" : "hover:bg-[var(--color-surface-2)]"
              } ${walkable(call) && !side ? "" : "opacity-55"}`}
              style={{ paddingLeft: 12 + depth * 12 }}
            >
              {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-accent)]" />}
              <span className="w-5 shrink-0 text-right text-[9.5px] tabular-nums text-[var(--color-ink-faint)]">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="mono flex items-baseline gap-1 text-[11.5px] text-[var(--color-ink)]">
                  <span className="truncate">
                    {call.receiver && <span className="text-[var(--color-ink-faint)]">{shorten(call.receiver)}.</span>}
                    {call.callee}
                  </span>
                  {more && (
                    <span
                      className="shrink-0 rounded bg-[var(--color-surface-3)] px-1 text-[9px] tabular-nums text-[var(--color-ink-muted)]"
                      title={t("同一块里还在第 {lines} 行调了它", { lines: more.map((c) => c.line).join(", ") })}
                    >
                      ×{more.length + 1}
                    </span>
                  )}
                  {call.trivial && <span className="shrink-0 text-[9px] text-[var(--color-ink-faint)]">{t("旁路")}</span>}
                </span>
                <span className="mono block truncate text-[9.5px] text-[var(--color-ink-faint)]">
                  L{call.line}
                  {call.resolution === "ambiguous"
                    ? ` · ${t("{count} 个候选", { count: call.candidates?.length ?? 0 })}`
                    : target
                      ? ` → ${crossFile ? target.filePath.split("/").at(-1) : t("同文件")}${target.forwardsTo ? ` ⇢ ${target.forwardsTo.name}` : ""}`
                      : call.external
                        ? ` · ${call.builtin ? t("内置 {name}", { name: call.external }) : call.external}`
                        : ""}
                </span>
                {call.tables && call.tables.length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {call.tables.map((table) => (
                      <span key={`${table.name}:${table.write}`} className="mono rounded bg-[var(--color-surface-3)] px-1 text-[9px]"
                        style={{ color: table.write ? "var(--color-warn)" : "var(--color-ink-muted)" }}>
                        {table.write ? t("写 {table}", { table: table.name }) : t("读 {table}", { table: table.name })}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              {call.io ? (
                <span className="shrink-0 rounded border border-[var(--color-warn)]/40 px-1 text-[9px] text-[var(--color-warn)]">
                  {t(IO_LABELS[call.io])}
                </span>
              ) : target?.reaches[0] ? (
                <span className="shrink-0 text-[9px] text-[var(--color-warn)]/70"
                  title={t("往下最少 {count} 层调用会访问{kind}", { count: target.reaches[0].depth + 1, kind: t(IO_LABELS[target.reaches[0].kind]) })}>
                  ↓{t(IO_LABELS[target.reaches[0].kind])}
                </span>
              ) : null}
            </button>
          </Fragment>
        );
      })}

      {steps.length === 0 && (
        <div className="px-3 py-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          {t("函数体里没有能继续走的调用。")}
        </div>
      )}
      {atEnd && caller && (
        <div className="px-3 py-2 text-[10.5px] text-[var(--color-ink-faint)]">
          {t("再按 ↓ 回到 {name}", { name: caller })}
        </div>
      )}
      <div className="mt-1 space-y-0.5 px-3">
        {folded.trivial > 0 && (
          <FoldNote onClick={() => setShowTrivial(true)}>
            {t("折叠了 {count} 处计时、日志类的旁路调用", { count: folded.trivial })}
          </FoldNote>
        )}
        {options.trivial && (
          <FoldNote onClick={() => setShowTrivial(false)}>{t("收起计时、日志类的旁路调用")}</FoldNote>
        )}
        {folded.offPath > 0 && (
          <FoldNote onClick={() => setMainPath(false)}>
            {t("只看主路径：另有 {count} 处在守卫分支或 catch 里", { count: folded.offPath })}
          </FoldNote>
        )}
        {external > 0 && (
          <FoldNote onClick={() => setAllCalls(true)}>
            {t("另有 {count} 处外部库或无法解析的调用", { count: external })}
          </FoldNote>
        )}
      </div>
    </aside>
  );
}

function FoldNote({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="block text-left text-[10.5px] text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink-muted)] hover:underline">
      {children}
    </button>
  );
}

/** Title line of the control structure: the keyword is written as in the code, and the condition is the truncated original source code */
function BlockHeader({ block, depth }: { block: DisplayBlock; depth: number }) {
  const t = useT();
  return (
    <div
      className="mono flex items-baseline gap-1.5 pb-0.5 pr-2.5 pt-1 text-[10px]"
      style={{ paddingLeft: 12 + depth * 12 + 28, color: block.guard ? "var(--color-ink-faint)" : "var(--color-ink-muted)" }}
      title={block.guard ? t("这个分支以 return / throw 收尾：主路径不会走进来") : undefined}
    >
      <span className="min-w-0 truncate">{blockLabel(block, t)}</span>
      {block.guard && <span className="shrink-0 font-sans text-[9px] text-[var(--color-warn)]/80">{t("守卫")}</span>}
      <span className="ml-auto shrink-0 tabular-nums text-[var(--color-ink-faint)]">L{block.line}</span>
    </div>
  );
}

function blockLabel(block: DisplayBlock, t: ReturnType<typeof useT>): string {
  const text = block.text ?? "";
  switch (block.kind) {
    case "if":
      return `if ${text}`;
    case "else-if":
      return `else if ${text}`;
    case "else":
      return "else";
    case "case":
      return text === "default" ? "default:" : `case ${text}:`;
    case "loop":
      return text || "loop";
    case "try":
      return "try";
    case "catch":
      return text ? `catch (${text})` : "catch";
    case "finally":
      return "finally";
    case "defer":
      return "defer";
    case "callback":
      return text === "go" ? "go" : text ? t("传给 {name} 的回调", { name: text }) : t("回调");
  }
}

/** Function source code. Each step call is marked on the called name, and an explanatory card is expanded below the current step. */
function FrameSource({ frame, steps, repeats, current, stackIds, onPick, onInto, onThrough }: {
  frame: WalkFrameDto;
  steps: readonly WalkCallDto[];
  repeats: ReadonlyMap<string, WalkCallDto[]>;
  current: WalkCallDto | null;
  stackIds: readonly string[];
  onPick: (id: string) => void;
  onInto: (target: WalkTargetDto) => void;
  onThrough: (target: WalkTargetDto) => void;
}) {
  const t = useT();
  const { source, error } = useSource(frame.fileId, frame.startLine, frame.endLine);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  // The merged duplicate calls are also marked in the source code; click on it to stop at the merged step.
  const byLine = useMemo(() => {
    const out = new Map<number, Array<{ call: WalkCallDto; step: WalkCallDto }>>();
    const add = (call: WalkCallDto, step: WalkCallDto) => {
      const bucket = out.get(call.line);
      if (bucket) bucket.push({ call, step }); else out.set(call.line, [{ call, step }]);
    };
    for (const step of steps) {
      add(step, step);
      for (const repeat of repeats.get(step.id) ?? []) add(repeat, step);
    }
    return out;
  }, [steps, repeats]);

  // Scroll only when the current position moves out of the visible area, so the screen doesn't jump with every step.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const focus = focusRef.current;
    if (!scroller || !focus) return;
    const view = scroller.getBoundingClientRect();
    const box = focus.getBoundingClientRect();
    if (box.top < view.top + 24 || box.bottom > view.bottom - 24) focus.scrollIntoView({ block: "center" });
  }, [current?.id, source]);

  if (error) return <WalkMessage>{error}</WalkMessage>;
  if (!source) return <WalkMessage>{t("正在读取源码…")}</WalkMessage>;
  const { lines, tokens, first } = source.range(frame.startLine, frame.endLine);

  return (
    <div ref={scrollerRef} className="thin-scroll min-w-0 flex-1 overflow-auto">
      <div className="w-max min-w-full py-2">
        {lines.map((text, i) => {
          const number = first + i;
          const calls = byLine.get(number) ?? [];
          const here = current !== null && current.line === number;
          const marks = calls.flatMap(({ call, step }): CodeMark[] => {
            const from = locate(text, call);
            if (from < 0) return [];
            const active = call === current;
            return [{
              from,
              to: from + call.callee.length,
              title: call.target ? `${call.target.name} · ${call.target.filePath}:${call.target.line}` : call.external ?? undefined,
              onClick: () => onPick(step.id),
              className: `cursor-pointer rounded-sm ${
                active
                  ? "bg-[var(--color-accent)]/25 outline outline-1 outline-[var(--color-accent)]"
                  : `underline decoration-dotted underline-offset-[3px] hover:bg-[var(--color-accent)]/10 ${
                      call.io ? "decoration-[var(--color-warn)]" : "decoration-[var(--color-accent)]/70"
                    }`
              }`,
            }];
          });
          const line = (
            <CodeLine
              number={number}
              text={text}
              tokens={tokens?.[i]}
              marked={here}
              gutter={here ? "var(--color-accent)" : calls.length > 0 ? "var(--color-line-strong)" : null}
              marks={marks}
            />
          );
          if (!here || !current) return <Fragment key={number}>{line}</Fragment>;
          return (
            <div key={number} ref={focusRef}>
              {line}
              <StepCard call={current} frame={frame} recursive={stackIds} onInto={onInto} onThrough={onThrough} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Give priority to the columns noted during parsing; if they don't match (such as embedded templates), fall back to finding them by name. */
function locate(text: string, call: WalkCallDto): number {
  if (text.startsWith(call.callee, call.column)) return call.column;
  const match = new RegExp(`(?<![\\w$])${call.callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).exec(text);
  return match ? match.index : -1;
}

function StepCard({ call, frame, recursive, onInto, onThrough }: {
  call: WalkCallDto;
  frame: WalkFrameDto;
  recursive: readonly string[];
  onInto: (target: WalkTargetDto) => void;
  onThrough: (target: WalkTargetDto) => void;
}) {
  const t = useT();
  const target = steppable(call);
  return (
    <div className="sticky left-0 my-1.5 ml-[52px] mr-4 w-[min(640px,calc(100vw_-_380px))] rounded-md border border-[var(--color-accent)]/35 bg-[var(--color-surface)] px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={`rounded border px-1 text-[9.5px] ${
          call.resolution === "exact" ? "border-[var(--color-accent)]/40 text-[var(--color-accent)]"
            : call.resolution === "likely" ? "border-[var(--color-warn)]/40 text-[var(--color-warn)]"
              : "border-[var(--color-line-strong)] text-[var(--color-ink-faint)]"
        }`}>
          {t(RESOLUTION_LABELS[call.resolution])}
        </span>
        {call.io && (
          <span className="rounded border border-[var(--color-warn)]/40 px-1 text-[9.5px] text-[var(--color-warn)]">
            {t("访问{kind}", { kind: t(IO_LABELS[call.io]) })}
          </span>
        )}
        {target ? (
          <>
            <span className="mono text-[var(--color-ink)]">{target.name}</span>
            <span className={`mono text-[10px] ${target.fileId !== frame.fileId ? "text-[var(--color-accent)]" : "text-[var(--color-ink-faint)]"}`}>
              {target.filePath}:{target.line}
            </span>
          </>
        ) : call.resolution === "external" ? (
          <span className="text-[var(--color-ink-muted)]">{callNote(call, t)}</span>
        ) : call.resolution === "unresolved" ? (
          <span className="text-[var(--color-ink-faint)]">{callNote(call, t)}</span>
        ) : null}
      </div>

      {call.arguments.length > 0 && (
        <div className="mono mt-1.5 truncate text-[10.5px] text-[var(--color-ink-muted)]" title={call.arguments.join(", ")}>
          <span className="text-[var(--color-ink-faint)]">{call.callee}(</span>
          {call.arguments.join(", ")}
          <span className="text-[var(--color-ink-faint)]">)</span>
        </div>
      )}

      {target?.summary && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">{target.summary}</p>}

      {call.tables && call.tables.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
          <span className="text-[var(--color-ink-faint)]">{t("SQL 里的表：")}</span>
          {call.tables.map((table) => (
            <span key={`${table.name}:${table.write}`} className="mono rounded bg-[var(--color-surface-3)] px-1"
              style={{ color: table.write ? "var(--color-warn)" : "var(--color-ink-muted)" }}>
              {table.write ? t("写 {table}", { table: table.name }) : t("读 {table}", { table: table.name })}
            </span>
          ))}
        </div>
      )}

      {target && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onInto(target)}
            className="flex items-center gap-1.5 rounded border border-[var(--color-accent)]/50 px-2 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10">
            {t("步入")}
            <kbd className="mono text-[10px]">→</kbd>
          </button>
          {target.forwardsTo && (
            <button type="button" onClick={() => onThrough(target)}
              title={t("{name} 只是把调用转给 {target}，直接进去看真正干活的那个", { name: target.name, target: target.forwardsTo.name })}
              className="rounded border border-[var(--color-line-strong)] px-2 py-0.5 text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
              {t("直接进 {name}", { name: target.forwardsTo.name })}
            </button>
          )}
          <span className="text-[10px] text-[var(--color-ink-faint)]">
            {target.steps > 0 ? t("里面还有 {count} 处调用", { count: target.steps }) : t("里面没有更多调用")}
          </span>
          {target.tests !== undefined && (
            <span className="text-[10px]" style={{ color: target.tests > 0 ? "var(--color-ink-faint)" : "var(--color-warn)" }}>
              {target.tests > 0 ? t("{count} 个测试走得到", { count: target.tests }) : t("没有测试走到")}
            </span>
          )}
          {recursive.includes(target.id) && <span className="text-[10px] text-[var(--color-warn)]">{t("递归")}</span>}
          <Reaches reaches={target.reaches} />
        </div>
      )}

      {call.resolution === "ambiguous" && call.candidates && (
        <div className="mt-2">
          <div className="text-[10px] text-[var(--color-ink-faint)]">{t("有多个同名实现，选一个步入：")}</div>
          <div className="mt-1 space-y-0.5">
            {call.candidates.map((candidate) => (
              <button key={candidate.id} type="button" onClick={() => onInto(candidate)}
                className="flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-[var(--color-surface-3)]">
                <span className="mono text-[11px] text-[var(--color-ink)]">{candidate.name}</span>
                <span className="mono truncate text-[10px] text-[var(--color-ink-faint)]">{candidate.filePath}:{candidate.line}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The receiver of a chained call is often an entire segment with multiple lines of actual parameters, and the content inside the parentheses does not help in identifying which step it is. */
function shorten(receiver: string): string {
  let out = "";
  let depth = 0;
  for (const ch of receiver) {
    if ("([{".includes(ch)) {
      if (depth === 0) out += `${ch}…`;
      depth += 1;
    } else if (")]}".includes(ch)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) out += ch;
    } else if (depth === 0) {
      out += ch;
    }
  }
  out = out.replace(/\s*\.\s*/g, ".").replace(/\s+/g, " ").trim();
  return out.length > 24 ? `…${out.slice(-22)}` : out;
}
