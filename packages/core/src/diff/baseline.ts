import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, INDEX_DIR, indexPath, isIndexCurrent, openDb } from "../db/database.js";
import { EXTRACTOR_VERSION, EXTRACTOR_VERSION_KEY, scanRepo, type ScanOptions } from "../pipeline/scan.js";
import type { CommitDto } from "../types.js";

export class BaselineError extends Error {}

export interface Baseline {
  ref: string;
  commit: string;
  dbPath: string;
  /** Hit the previously built baseline index */
  reused: boolean;
}

const KEEP_BASELINES = 6;
/** When the same submitted baseline is requested twice at the same time, it shares a single build; otherwise, both sides would write to the same cache file. */
const building = new Map<string, Promise<Baseline>>();

/**
 * Create a structural index for a git commit as a baseline for change comparison.
 *
 * Use `git archive` to export a snapshot instead of checkout/worktree: does not touch the user's working directory or git metadata,
 * Unsubmitted changes will not be included either. The content of a commit cannot be changed, so the index is cached according to the commit.
 * `.repolens/baselines/` is only rebuilt when the parser is upgraded.
 */
export async function buildBaseline(
  root: string, ref: string, onProgress?: ScanOptions["onProgress"],
): Promise<Baseline> {
  // ref will enter the git parameter table: those starting with - will be treated as options, and the rest of the characters are only allowed if they are needed in commit syntax
  if (ref.startsWith("-") || !/^[\w./~^@{}+-]{1,200}$/.test(ref)) {
    throw new BaselineError(`不支持的提交写法：${ref.slice(0, 80)}`);
  }
  const top = git(root, ["rev-parse", "--show-toplevel"], "不是 git 仓库，没法按提交对比");
  const commit = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], `找不到提交 ${ref}`);
  const cacheDir = join(root, INDEX_DIR, "baselines");
  const dbPath = join(cacheDir, `${commit}.db`);
  if (isBaselineCurrent(dbPath)) return { ref, commit, dbPath, reused: true };

  const pending = building.get(dbPath);
  if (pending) return { ...(await pending), ref };
  const task = snapshotAndScan(root, top, commit, cacheDir, dbPath, onProgress)
    .then(() => ({ ref, commit, dbPath, reused: false }))
    .finally(() => building.delete(dbPath));
  building.set(dbPath, task);
  return task;
}

async function snapshotAndScan(
  root: string, top: string, commit: string, cacheDir: string, dbPath: string,
  onProgress: ScanOptions["onProgress"],
): Promise<void> {
  // The scan root may be a subdirectory in the monorepo, and the snapshot needs to restore the same relative position. Let git calculate it itself:
  // The temporary directory in Windows is often an 8.3 short path (RUNNER~1), which does not match the repository root given by git when compared as strings.
  const prefix = git(root, ["rev-parse", "--show-prefix"], "没法确定扫描根在仓库里的位置").replace(/\/$/, "");
  const snapshot = mkdtempSync(join(tmpdir(), "repolens-baseline-"));
  try {
    // When the subdirectory does not yet exist in that commit, the baseline is empty, and git archive will directly report a pathspec error.
    if (!prefix || succeeds(top, ["cat-file", "-e", `${commit}:${prefix}`])) {
      await extractCommit(top, commit, prefix, snapshot);
    }
    const snapshotRoot = prefix ? join(snapshot, prefix) : snapshot;
    mkdirSync(snapshotRoot, { recursive: true });
    await scanRepo({ root: snapshotRoot, fresh: true, structureOnly: true, onProgress });

    mkdirSync(cacheDir, { recursive: true });
    rmSync(dbPath, { force: true });
    const db = openDb(indexPath(snapshotRoot));
    try {
      await db.backup(dbPath);
    } finally {
      db.close();
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
  pruneBaselines(cacheDir, dbPath);
}

/** The current HEAD commit number; null if not in git */
export function headCommit(root: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], "");
  } catch {
    return null;
  }
}

/**
 * Commits from HEAD backwards, used to pick a baseline for change comparison. Only list commits that touched the scan root: commits that haven't touched it are excluded.
 * Snapshots that are exactly the same as the previous one are listed just as noise. Return an empty list if not in git or not yet committed.
 */
export function listCommits(root: string, limit = 50): CommitDto[] {
  let out: string;
  try {
    out = git(root, ["log", `-n${limit}`, "--decorate=full", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%D%x1e", "--", "."], "");
  } catch {
    return [];
  }
  return out.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [commit = "", short = "", subject = "", author = "", date = "", decorations = ""] = record.split("\x1f");
    const result: CommitDto = { commit, short, subject, author, date, head: false, branches: [], tags: [] };
    for (const decoration of decorations.split(", ").filter(Boolean)) {
      const ref = decoration.replace(/^HEAD -> /, "");
      if (ref !== decoration || ref === "HEAD") result.head = true;
      if (ref.startsWith("refs/heads/")) result.branches.push(ref.slice("refs/heads/".length));
      else if (ref.startsWith("tag: refs/tags/")) result.tags.push(ref.slice("tag: refs/tags/".length));
    }
    return result;
  });
}

function isBaselineCurrent(dbPath: string): boolean {
  if (!isIndexCurrent(dbPath)) return false;
  const db = openDb(dbPath, { readonly: true });
  try {
    return getMeta(db, EXTRACTOR_VERSION_KEY) === EXTRACTOR_VERSION;
  } finally {
    db.close();
  }
}

function git(cwd: string, args: string[], failure: string): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new BaselineError(failure);
  }
}

function succeeds(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function extractCommit(top: string, commit: string, prefix: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", top, "archive", "--format=tar", commit, ...(prefix ? ["--", prefix] : [])], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // No need for -C: Git for Windows comes with GNU tar, which treats the colon in C:\ as a remote host
    const untar = spawn("tar", ["-x", "-f", "-"], { cwd: into, stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(untar.stdin);
    let stderr = "";
    archive.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    untar.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    let pending = 2;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new BaselineError(`导出提交 ${commit.slice(0, 8)} 失败：${message}`));
    };
    const done = (code: number | null) => {
      if (code !== 0) return fail(stderr.trim() || `exit ${code}`);
      if (--pending === 0 && !settled) {
        settled = true;
        resolve();
      }
    };
    archive.on("error", (err) => fail(err.message));
    untar.on("error", (err) => fail(err.message));
    archive.on("close", done);
    untar.on("close", done);
  });
}

function pruneBaselines(cacheDir: string, keep: string): void {
  const dbs = readdirSync(cacheDir)
    .filter((name) => name.endsWith(".db"))
    .map((name) => join(cacheDir, name))
    .filter((path) => path !== keep && existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const stale of dbs.slice(KEEP_BASELINES - 1)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${stale}${suffix}`, { force: true });
  }
}
