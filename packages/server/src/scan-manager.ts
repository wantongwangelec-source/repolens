import {
  indexPath,
  isIndexCurrent,
  gitBranch,
  rememberRepo,
  scanRepo,
  type RegisteredRepo,
  type RepoEntry,
  type RepoScanTaskDto,
  type ScanPhase,
} from "@repolens/core";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

type ScanWorkerMessage =
  | { type: "progress"; phase: ScanPhase; done: number; total: number }
  | { type: "completed" }
  | { type: "failed"; error: string };

const PHASES: ReadonlyArray<{ phase: ScanPhase; weight: number }> = [
  { phase: "discover", weight: 0.05 },
  { phase: "parse", weight: 0.55 },
  { phase: "resolve", weight: 0 },
  { phase: "link", weight: 0.08 },
  { phase: "rollup", weight: 0.05 },
  { phase: "enrich", weight: 0.22 },
  { phase: "index", weight: 0.05 },
];

const MAX_RETAINED_TASKS = 20;

export class ScanBusyError extends Error {}
export class InvalidScanRootError extends Error {}

/** Memory scan task queue. Tasks disappear after the service restarts, but the indexes that have been written will not disappear. */
export class ScanManager {
  private readonly tasks = new Map<string, RepoScanTaskDto>();
  private activeId: string | null = null;
  private activeWorker: Worker | null = null;
  /** Refreshing structures that are running, based on the repository root; for the same repository, only run once at the same time */
  private readonly refreshing = new Map<string, Promise<void>>();
  /** A request came in again during the refresh: finish this run first and then do another one to ensure the last change is definitely included. */
  private readonly dirty = new Set<string>();
  private readonly refreshWorkers = new Set<Worker>();

  /** This repository is undergoing a full scan (add or rescan) */
  isScanning(root: string): boolean {
    const active = this.activeId === null ? undefined : this.tasks.get(this.activeId);
    return active?.status === "running" && active.root === resolve(root);
  }

  /**
   * Incremental scan that only refreshes the structure, does not invoke the model, does not occupy a scan task slot, and does not display progress in the repository menu:
   * Automatic refresh after file changes and 'Rescan and Compare' all go through here. Concurrent requests in the same repository are merged into one.
   * If there are new requests during this period, just add them again after this run is finished. Wait for the full scan to finish when writing to the same index—it will include these changes together.
   */
  refresh(root: string): Promise<void> {
    const key = resolve(root);
    const running = this.refreshing.get(key);
    if (running) {
      this.dirty.add(key);
      return running;
    }
    const task = (async () => {
      do {
        this.dirty.delete(key);
        while (this.isScanning(key)) await delay(300);
        await this.runRefresh(key);
      } while (this.dirty.has(key));
    })().finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, task);
    return task;
  }

  private runRefresh(root: string): Promise<void> {
    // When running the TS source code directly (testing, development), the worker script that hasn't been compiled yet is scanned on the spot
    const script = new URL("./scan-worker.js", import.meta.url);
    if (script.protocol === "file:" && !existsSync(fileURLToPath(script))) {
      return scanRepo({ root, structureOnly: true }).then(() => undefined);
    }
    return new Promise((done, fail) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
          workerData: { root, structureOnly: true },
          execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
        });
      } catch (err) {
        fail(err);
        return;
      }
      this.refreshWorkers.add(worker);
      let settled = false;
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        this.refreshWorkers.delete(worker);
        if (err) fail(err); else done();
      };
      worker.on("message", (message: ScanWorkerMessage) => {
        if (message.type === "completed") finish(null);
        else if (message.type === "failed") finish(new Error(message.error));
      });
      worker.on("error", (err) => finish(err));
      worker.on("exit", (code) => finish(code === 0 ? null : new Error(`刷新进程退出（代码 ${code}）`)));
    });
  }

  start(selectedRoot: string, options: { scanExisting?: boolean } = {}): RepoScanTaskDto {
    if (this.activeId !== null) {
      const active = this.tasks.get(this.activeId);
      if (active?.status === "running") {
        throw new ScanBusyError(`正在扫描 ${active.name}，请等待当前任务完成`);
      }
      this.activeId = null;
    }

    const root = validateRoot(selectedRoot);
    const now = new Date().toISOString();
    const task: RepoScanTaskDto = {
      id: randomUUID(),
      root,
      name: basename(root) || root,
      status: "running",
      phase: null,
      done: 0,
      total: 0,
      progress: 0,
      startedAt: now,
      completedAt: null,
      error: null,
      repo: null,
    };
    this.tasks.set(task.id, task);
    this.trim();

    // If an index is already available, just register the repository in the list, without performing a meaningless full rescan.
    if (!options.scanExisting && isIndexCurrent(indexPath(root))) {
      try {
        task.repo = asEntry(rememberRepo(root));
        task.status = "completed";
        task.progress = 1;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        fail(task, err);
      }
      return snapshot(task);
    }

    this.activeId = task.id;
    this.run(task);
    return snapshot(task);
  }

  get(id: string): RepoScanTaskDto | null {
    const task = this.tasks.get(id);
    return task ? snapshot(task) : null;
  }

  list(): RepoScanTaskDto[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(snapshot);
  }

  async close(): Promise<void> {
    const worker = this.activeWorker;
    const task = this.activeId === null ? null : this.tasks.get(this.activeId);
    this.activeWorker = null;
    this.activeId = null;
    if (task?.status === "running") fail(task, new Error("服务已停止，扫描中断"));
    if (worker !== null) await worker.terminate();
    await Promise.all([...this.refreshWorkers].map((w) => w.terminate()));
    this.refreshWorkers.clear();
  }

  private run(task: RepoScanTaskDto): void {
    // Parsing and writing to SQLite involves a lot of synchronous CPU work. It can only allow the main thread if placed in a worker.
    // Continuously respond to progress polling, rather than refreshing to 100% all at once only after the scan is complete.
    let worker: Worker;
    try {
      worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
        workerData: { root: task.root },
        // Some embedded startup methods attach parameters to the main process that are only applicable to stdin/eval,
        // Inheriting as is will cause the worker to exit before executing the script.
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      });
    } catch (err) {
      fail(task, err);
      if (this.activeId === task.id) this.activeId = null;
      return;
    }
    this.activeWorker = worker;
    const release = () => {
      if (this.activeId === task.id) this.activeId = null;
      if (this.activeWorker === worker) this.activeWorker = null;
    };

    worker.on("message", (message: ScanWorkerMessage) => {
      if (task.status !== "running") return;
      if (message.type === "progress") {
        task.phase = message.phase;
        task.done = message.done;
        task.total = message.total;
        task.progress = phaseProgress(message.phase, message.done, message.total);
        return;
      }
      if (message.type === "failed") {
        fail(task, new Error(message.error));
        release();
        return;
      }

      try {
        task.repo = asEntry(rememberRepo(task.root));
        task.status = "completed";
        task.progress = 1;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        fail(task, err);
      } finally {
        release();
      }
    });

    worker.on("error", (err) => {
      if (task.status !== "running") return;
      fail(task, err);
      release();
    });

    worker.on("exit", (code) => {
      if (task.status !== "running") return;
      fail(task, new Error(`扫描进程在返回结果前退出（代码 ${code}）`));
      release();
    });
  }

  private trim(): void {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return;
    const completed = [...this.tasks.values()]
      .filter((task) => task.status !== "running")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (this.tasks.size > MAX_RETAINED_TASKS) {
      const oldest = completed.shift();
      if (!oldest) return;
      this.tasks.delete(oldest.id);
    }
  }
}

function validateRoot(input: string): string {
  const root = resolve(input);
  try {
    if (!statSync(root).isDirectory()) throw new Error("不是目录");
  } catch {
    throw new InvalidScanRootError(`所选目录不存在或无法访问：${root}`);
  }

  // Scanning the root directory of the file system or the entire home directory is almost certainly a mistake and could take several hours.
  if (root === parse(root).root || root === resolve(homedir())) {
    throw new InvalidScanRootError("请选择具体的代码仓库目录，不要选择磁盘根目录或整个用户目录");
  }
  return root;
}

function phaseProgress(phase: ScanPhase, done: number, total: number): number {
  let before = 0;
  let weight = 0;
  for (const item of PHASES) {
    if (item.phase === phase) {
      weight = item.weight;
      break;
    }
    before += item.weight;
  }
  const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return Math.min(0.99, before + weight * fraction);
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function asEntry(repo: RegisteredRepo): RepoEntry {
  return { ...repo, status: "ok", branch: gitBranch(repo.root) };
}

function fail(task: RepoScanTaskDto, err: unknown): void {
  task.status = "failed";
  task.error = err instanceof Error ? err.message : String(err);
  task.completedAt = new Date().toISOString();
}

function snapshot(task: RepoScanTaskDto): RepoScanTaskDto {
  return { ...task, repo: task.repo ? { ...task.repo } : null };
}
