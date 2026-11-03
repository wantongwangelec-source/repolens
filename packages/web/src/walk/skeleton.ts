import type { ControlBlock, ControlBlockKind, WalkCallDto, WalkFrameDto } from "@repolens/core/types";

export interface StepOptions {
  /** External libraries and calls that cannot be parsed are also considered steps. */
  all: boolean;
  /** Timing, logging, and event tracking type of side calls are also considered steps */
  trivial: boolean;
  /** Only look at the main path: calls in guard branches (if statements that return/throw early) and in catch blocks do not count */
  mainPath: boolean;
}

export interface Skeleton {
  steps: WalkCallDto[];
  /** Repeatedly calling the same function within the same block, only keep the first call as a step; here, remember the subsequent calls that got merged */
  repeats: Map<string, WalkCallDto[]>;
  /** There are several occurrences of folded bypass calls and calls outside the main path. */
  folded: { trivial: number; offPath: number };
}

/** By default, only calls to functions that can land inside the repository and I/O are considered steps, consistent with the server-side's definition of 'how many steps can still be taken'. */
export function walkable(call: WalkCallDto): boolean {
  return call.resolution === "exact" || call.resolution === "likely" || call.resolution === "ambiguous" || !!call.io;
}

/** Calls in guard branches or error handling: can be skipped when reading the main thread */
export function offMainPath(call: WalkCallDto): boolean {
  return (call.blocks ?? []).some((block) => (block.k === "if" && block.x === 1) || block.k === "catch");
}

/**
 * Organize the calls in the function body into step-by-step walk-throughs. Keep the order unchanged, only do subtraction: first filter by 'all calls', then fold bypass calls,
 * Remove everything except the main path, and finally merge duplicate calls to the same function within the same block in one step. Record exactly how much was reduced.
 */
export function buildSkeleton(frame: WalkFrameDto, options: StepOptions): Skeleton {
  const folded = { trivial: 0, offPath: 0 };
  const candidates = frame.calls.filter((call) => {
    if (!options.all && !walkable(call)) return false;
    if (!options.trivial && call.trivial && !call.io) {
      folded.trivial++;
      return false;
    }
    if (options.mainPath && offMainPath(call)) {
      folded.offPath++;
      return false;
    }
    return true;
  });

  const steps: WalkCallDto[] = [];
  const repeats = new Map<string, WalkCallDto[]>();
  const firstOf = new Map<string, WalkCallDto>();
  for (const call of candidates) {
    const target = call.resolution === "ambiguous" ? null : call.target;
    if (!target) {
      steps.push(call);
      continue;
    }
    const key = `${blockKey(call)}|${target.id}`;
    const first = firstOf.get(key);
    if (!first) {
      firstOf.set(key, call);
      steps.push(call);
      continue;
    }
    const list = repeats.get(first.id);
    if (list) list.push(call); else repeats.set(first.id, [call]);
  }
  return { steps, repeats, folded };
}

/** Control block for display: else followed on the same line by if forms an else if */
export interface DisplayBlock {
  /** Use the starting byte of the innermost block as the key */
  key: string;
  kind: ControlBlockKind | "else-if";
  text: string | undefined;
  line: number;
  guard: boolean;
}

export function displayBlocks(call: WalkCallDto): DisplayBlock[] {
  const blocks = call.blocks ?? [];
  const out: DisplayBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    if (block.k === "else" && next?.k === "if" && next.l === block.l) {
      out.push({ key: `${block.b}:${next.b}`, kind: "else-if", text: next.t, line: next.l, guard: next.x === 1 });
      i++;
      continue;
    }
    out.push({ key: String(block.b), kind: block.k, text: block.t, line: block.l, guard: block.x === 1 });
  }
  return out;
}

/** Block title inserted when rendering the checklist: the few layers newly introduced compared to the previous step */
export function openedBlocks(previous: WalkCallDto | null, call: WalkCallDto): Array<{ block: DisplayBlock; depth: number }> {
  const before = previous ? displayBlocks(previous) : [];
  const now = displayBlocks(call);
  let shared = 0;
  while (shared < before.length && shared < now.length && before[shared]!.key === now[shared]!.key) shared++;
  return now.slice(shared).map((block, index) => ({ block, depth: shared + index }));
}

function blockKey(call: WalkCallDto): string {
  return (call.blocks ?? []).map((block: ControlBlock) => block.b).join(".");
}
