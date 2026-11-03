import type { SourceSliceDto } from "@repolens/core/types";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { shikiLanguage, useHighlightedLines, type CodeToken } from "../lib/highlight";
import { useAppStore } from "../store/useAppStore";

export interface LoadedSource {
  slice: SourceSliceDto;
  lines: string[];
  tokens: CodeToken[][] | null;
  /** Get the original text of absolute line numbers [from, to], truncate any out-of-bounds parts */
  range: (from: number, to: number) => { lines: string[]; tokens: CodeToken[][] | null; first: number };
}

/**
 * The pseudocode and source code tabs display the same piece of source code, so there is no need to make repeated requests when switching back and forth.
 * Include the repository revision number in the key; it will naturally become invalid after rescanning or changing the repository.
 */
const sliceCache = new Map<string, Promise<SourceSliceDto>>();
/** The obtained results can be synced accordingly: when walking in and out in the walk-through, the function should not flash 'Loading' every time. */
const loadedSlices = new Map<string, SourceSliceDto>();
const SLICE_CACHE_SIZE = 16;

function loadSlice(key: string, fileId: string, from?: number, to?: number): Promise<SourceSliceDto> {
  const cached = sliceCache.get(key);
  if (cached) return cached;
  // Files not included in the index do not have a numeric id; the node id is raw:<repository relative path>
  const task = fileId.startsWith("raw:") ? api.rawSource(fileId.slice(4)) : api.source(fileId, from, to);
  sliceCache.set(key, task);
  task.then(
    (slice) => { if (sliceCache.get(key) === task) loadedSlices.set(key, slice); },
    () => sliceCache.delete(key),
  );
  if (sliceCache.size > SLICE_CACHE_SIZE) {
    const oldest = sliceCache.keys().next().value;
    if (oldest !== undefined) {
      sliceCache.delete(oldest);
      loadedSlices.delete(oldest);
    }
  }
  return task;
}

export function useSource(
  fileId: string,
  from?: number,
  to?: number,
): { source: LoadedSource | null; error: string | null } {
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const key = `${repoId ?? ""}:${repoRevision}.${indexRevision}:${fileId}:${from ?? ""}:${to ?? ""}`;
  const [state, setState] = useState<{ key: string; slice: SourceSliceDto | null; error: string | null }>({
    key: "",
    slice: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    void loadSlice(key, fileId, from, to)
      .then((slice) => !cancelled && setState({ key, slice, error: null }))
      .catch((err: Error) => !cancelled && setState({ key, slice: null, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [key, fileId, from, to]);

  const slice = state.key === key ? state.slice : loadedSlices.get(key) ?? null;
  const tokens = useHighlightedLines(slice?.code ?? null, slice ? shikiLanguage(slice.language, slice.path) : null);

  // A stable reference is required for it to be treated as an effect dependency downstream; otherwise, each render is like using a different source code.
  const source = useMemo<LoadedSource | null>(() => {
    if (!slice) return null;
    const lines = slice.code.split("\n");
    return {
      slice,
      lines,
      tokens,
      range: (rangeFrom, rangeTo) => {
        const first = Math.max(rangeFrom, slice.startLine);
        const last = Math.min(rangeTo, slice.startLine + lines.length - 1);
        const start = first - slice.startLine;
        const end = Math.max(start, last - slice.startLine + 1);
        return {
          first,
          lines: lines.slice(start, end),
          tokens: tokens ? tokens.slice(start, end) : null,
        };
      },
    };
  }, [slice, tokens]);

  return { source, error: slice || state.key !== key ? null : state.error };
}
