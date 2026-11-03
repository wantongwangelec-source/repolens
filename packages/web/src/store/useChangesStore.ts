import type { ChangeReportDto, GraphNodeDto } from "@repolens/core/types";
import { create } from "zustand";
import { api } from "../api/client";
import { readPref, writePref } from "../lib/prefs";
import { useAppStore } from "./useAppStore";

const BASE_PREF = "repolens:changes-base";

export type ChangeMark = "added" | "modified";

interface ChangeIndex {
  /** File and Symbol Node ID → Change Type */
  byId: Map<string, ChangeMark>;
  /** Files after adding, modifying, or moving; directory and package nodes sorted by prefix count */
  files: Array<{ path: string; source: boolean }>;
}

interface ChangesState {
  base: string;
  report: ChangeReportDto | null;
  index: ChangeIndex | null;
  status: "idle" | "loading" | "ready" | "error";
  /** Staging changes from the working directory */
  rescanning: boolean;
  error: string | null;
  compare: (base?: string) => Promise<void>;
  /** First perform an incremental scan that only refreshes the structure, then compare: what you see when watch is off is also the current code. */
  rescanAndCompare: () => Promise<void>;
}

/** When changing repositories or rescanning incrementally: the node ID will change, and the IDs in the old report will not match the new graph. */
let generation = 0;
/** Incremental comparison each time: index refresh triggers a new comparison, and the old comparison sent out earlier cannot overwrite the new one when it comes back late. */
let sequence = 0;
let inflight: Promise<void> | null = null;

export const useChangesStore = create<ChangesState>((set, get) => ({
  base: readPref(BASE_PREF) || "HEAD",
  report: null,
  index: null,
  status: "idle",
  rescanning: false,
  error: null,

  compare(base) {
    const ref = (base ?? get().base).trim() || "HEAD";
    const current = generation;
    const seq = ++sequence;
    writePref(BASE_PREF, ref === "HEAD" ? null : ref);
    set({ base: ref, status: "loading", error: null });
    const run = (async () => {
      try {
        const report = await api.changes(ref);
        if (current === generation && seq === sequence) set({ report, index: buildIndex(report), status: "ready" });
      } catch (err) {
        if (current === generation && seq === sequence) set({ status: "error", error: (err as Error).message });
      }
    })();
    inflight = run;
    void run.finally(() => {
      if (inflight === run) inflight = null;
    });
    return run;
  },

  async rescanAndCompare() {
    const repoId = useAppStore.getState().repoId;
    const current = generation;
    if (repoId !== null) {
      set({ rescanning: true, error: null });
      try {
        const { refreshedAt } = await api.refreshIndex(repoId);
        // When a report already exists, the index refresh will automatically trigger a comparison once (see the subscription below), just wait for it.
        await useAppStore.getState().refreshIndex(refreshedAt);
      } catch (err) {
        if (current === generation) set({ status: "error", error: (err as Error).message });
        return;
      } finally {
        if (current === generation) set({ rescanning: false });
      }
    }
    if (current === generation) await (inflight ?? get().compare());
  },
}));

useAppStore.subscribe((state, previous) => {
  if (state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision) {
    generation++;
    useChangesStore.setState({ report: null, index: null, status: "idle", rescanning: false, error: null });
    return;
  }
  // watch or manually refresh to stage the changes: the open report recalculates along, and the change page becomes a real-time monitoring screen
  if (state.indexRevision !== previous.indexRevision && useChangesStore.getState().report !== null) {
    void useChangesStore.getState().compare();
  }
});

function buildIndex(report: ChangeReportDto): ChangeIndex {
  const byId = new Map<string, ChangeMark>();
  const files: ChangeIndex["files"] = [];
  for (const file of report.files) {
    if (file.id === null) continue;
    byId.set(file.id, file.status === "added" ? "added" : "modified");
    files.push({ path: file.path, source: file.role === "source" });
  }
  for (const symbol of report.symbols) {
    if (symbol.id !== null) byId.set(symbol.id, symbol.status === "added" ? "added" : "modified");
  }
  return { byId, files };
}

/**
 * Change markers on graph nodes: files and symbols are looked up directly; for directories and packages, the modified files underneath them,
 * This way, you can see at the top level which areas this change affects.
 */
export function changeMarkOf(
  index: ChangeIndex | null,
  dto: GraphNodeDto,
  showNoise: boolean,
): { mark: ChangeMark; count: number } | null {
  if (index === null) return null;
  const direct = index.byId.get(dto.id);
  if (direct) return { mark: direct, count: 1 };
  if (dto.kind !== "directory" && dto.kind !== "package") return null;
  const dir = dto.path ?? "";
  const all = dir === "" || dir === ".";
  const count = index.files.filter(
    (file) => (showNoise || file.source) && (all || file.path.startsWith(`${dir}/`)),
  ).length;
  return count > 0 ? { mark: "modified", count } : null;
}
