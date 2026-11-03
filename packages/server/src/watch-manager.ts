import { indexChangeFilter } from "@repolens/core";
import { watch, type FSWatcher } from "node:fs";
import type { ScanManager } from "./scan-manager.js";

/** When continuously saving and AI edits more than ten files at once, wait until there are no new changes before refreshing again */
const DEBOUNCE_MS = 700;

export interface WatchStatus {
  enabled: boolean;
  /** Adding changes to the index */
  refreshing: boolean;
  /** The last refresh completion time */
  refreshedAt: string | null;
  /** The reason for the last refresh failure */
  error: string | null;
}

export type WatchEvent =
  | { type: "status"; status: WatchStatus }
  /** The index has been refreshed according to the latest files, and the interface should reload the data. */
  | { type: "index"; refreshedAt: string };

interface Watched {
  root: string;
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  status: WatchStatus;
}

/**
 * Keep an eye on the warehouse directory, perform an incremental scan that only refreshes the structure whenever a file changes, and then notify the interface.
 *
 * When AI is modifying the code on the side, users can see the charts, physical examination, and changes page update without manually rescanning: the changes page is based on the start of the session.
 * Submit for baseline real-time updates, equivalent to a monitor screen showing 'What structure AI changed this time.' Ignore when rules and scans are consistent.
 * Changes in directories like .git, .repolens, and node_modules do not trigger a refresh.
 */
export class WatchManager {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly scans: ScanManager,
    private readonly notify: (repoId: string, event: WatchEvent) => void,
  ) {}

  status(repoId: string): WatchStatus {
    return this.watched.get(repoId)?.status ?? { enabled: false, refreshing: false, refreshedAt: null, error: null };
  }

  start(repoId: string, root: string): WatchStatus {
    const existing = this.watched.get(repoId);
    if (existing) return existing.status;
    const relevant = indexChangeFilter(root);

    const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => {
      if (!relevant(typeof file === "string" ? file : null)) return;
      const entry = this.watched.get(repoId);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => void this.refresh(repoId), DEBOUNCE_MS);
    });
    watcher.on("error", (err) => {
      const entry = this.watched.get(repoId);
      if (!entry) return;
      entry.status = { ...entry.status, error: err.message };
      this.notify(repoId, { type: "status", status: entry.status });
    });

    const entry: Watched = { root, watcher, timer: null, status: { enabled: true, refreshing: false, refreshedAt: null, error: null } };
    this.watched.set(repoId, entry);
    this.notify(repoId, { type: "status", status: entry.status });
    return entry.status;
  }

  stop(repoId: string): WatchStatus {
    const entry = this.watched.get(repoId);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher.close();
      this.watched.delete(repoId);
    }
    const status = this.status(repoId);
    this.notify(repoId, { type: "status", status });
    return status;
  }

  close(): void {
    for (const repoId of [...this.watched.keys()]) this.stop(repoId);
  }

  private async refresh(repoId: string): Promise<void> {
    const entry = this.watched.get(repoId);
    if (!entry) return;
    entry.timer = null;
    entry.status = { ...entry.status, refreshing: true, error: null };
    this.notify(repoId, { type: "status", status: entry.status });
    try {
      await this.scans.refresh(entry.root);
      const refreshedAt = new Date().toISOString();
      entry.status = { ...entry.status, refreshing: false, refreshedAt };
      this.notify(repoId, { type: "index", refreshedAt });
    } catch (err) {
      entry.status = { ...entry.status, refreshing: false, error: (err as Error).message };
    }
    if (this.watched.get(repoId) === entry) this.notify(repoId, { type: "status", status: entry.status });
  }
}
