import type { LensKind, LensValueDto } from "@repolens/core/types";
import { create } from "zustand";
import { api } from "../api/client";
import { useAppStore } from "./useAppStore";

/** The server can calculate up to this many nodes at a time */
const BATCH = 150;

interface LensState {
  /** From which perspective were the following values taken? */
  kind: LensKind | null;
  values: Record<string, LensValueDto>;
  /** Among the nodes already retrieved, the one with the most submissions in the past 90 days, normalize the popularity based on it. */
  maxRecent: number;
  /** Increment when the cache is cleared: the canvas uses this to re-fetch the current nodes. */
  revision: number;
  ensure: (kind: LensKind, ids: readonly string[]) => Promise<void>;
}

let generation = 0;
const pending = new Set<string>();

export const useLensStore = create<LensState>((set, get) => ({
  kind: null,
  values: {},
  maxRecent: 0,
  revision: 0,

  async ensure(kind, ids) {
    if (get().kind !== kind) reset(kind);
    const missing = ids.filter((id) => !(id in get().values) && !pending.has(id));
    if (missing.length === 0) return;
    const current = generation;
    for (const id of missing) pending.add(id);
    try {
      for (let offset = 0; offset < missing.length; offset += BATCH) {
        const batch = missing.slice(offset, offset + BATCH);
        const values = await api.lens(kind, batch);
        if (current !== generation) return;
        const filled = Object.fromEntries(batch.map((id) => [id, values[id] ?? {}]));
        set((state) => {
          const merged = { ...state.values, ...filled };
          const maxRecent = Math.max(state.maxRecent, ...Object.values(filled).map((value) => value.recent ?? 0));
          return { values: merged, maxRecent };
        });
      }
    } catch {
      // The perspective is just an overlay; if you can't capture it, don't draw it.
    } finally {
      for (const id of missing) pending.delete(id);
    }
  },
}));

function reset(kind: LensKind | null): void {
  generation++;
  pending.clear();
  useLensStore.setState((state) => ({ kind, values: {}, maxRecent: 0, revision: state.revision + 1 }));
}

useAppStore.subscribe((state, previous) => {
  if (
    state.repoId !== previous.repoId ||
    state.repoRevision !== previous.repoRevision ||
    state.indexRevision !== previous.indexRevision ||
    state.lens !== previous.lens
  ) {
    reset(state.lens);
  }
});
