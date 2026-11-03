import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { indexPath } from "./db/database.js";
import type { RegisteredRepo, RepoEntry, RepoStatus } from "./types.js";

export type { RegisteredRepo, RepoEntry, RepoStatus } from "./types.js";

/**
 * Scanned warehouse inventory.
 *
 * The index itself exists under each repository's own `.repolens/`, which is intentional—it is rebuildable.
 * Derived data follows the repository and can only be deleted along with the repository. But in this way, no one knows about it anywhere.
 * "Which warehouses this machine has scanned," the interface doesn’t allow selecting warehouses; you can only change the path by restarting.
 * This list fills that gap.
 *
 * It is a convenient cache, not a source of truth: the truth is always whether each repository's index.db exists or not.
 * So when reading, always detect the state on-site; if parsing fails, treat it as an empty list, and never assume it is broken.
 * And makes the entire tool unable to start.
 */

export const HOME_DIR = ".repolens";
export const REGISTRY_FILE = "repos.json";

/** The list has a retention limit. Once exceeded, items will be removed based on the most recent access time to prevent unlimited growth. */
const MAX_ENTRIES = 50;

const REGISTRY_VERSION = 1;

export function registryPath(): string {
  return join(homedir(), HOME_DIR, REGISTRY_FILE);
}

/**
 * Repository identifier: short hash of the absolute path.
 *
 * Not using the path directly as the ID is because it will go into the URL — slashes, spaces, and Chinese characters in the path all need to be escaped.
 * A single typo is an undetectable 404. The hash is of fixed length and URL-safe, but the real path still exists.
 * The payload is returned to the interface for display, without any loss of information.
 */
export function repoId(root: string): string {
  return createHash("sha1").update(resolve(root)).digest("hex").slice(0, 12);
}

interface RegistryFile {
  version: number;
  repos: RegisteredRepo[];
}

export function readRegistry(): RegisteredRepo[] {
  const file = registryPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RegistryFile;
    if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.repos)) return [];
    return parsed.repos.filter(isWellFormed);
  } catch {
    // If the device is broken by hand, loses power during writing, or the format is changed in the future — all of these are considered as never having existed.
    return [];
  }
}

/** Add the warehouse to the list (if it already exists, refresh the opening time) and return the recorded entry. */
export function rememberRepo(root: string): RegisteredRepo {
  const absolute = resolve(root);
  const entry: RegisteredRepo = {
    id: repoId(absolute),
    root: absolute,
    name: repoDisplayName(absolute),
    lastOpenedAt: new Date().toISOString(),
  };

  const others = readRegistry().filter((r) => r.id !== entry.id);
  writeRegistry([entry, ...others].slice(0, MAX_ENTRIES));
  return entry;
}

/** Remove from the list. Return whether anything was actually removed. */
export function forgetRepo(id: string): boolean {
  const before = readRegistry();
  const after = before.filter((r) => r.id !== id);
  if (after.length === before.length) return false;
  writeRegistry(after);
  return true;
}

/** The status of the checklist + on-site detection, sorted by most recently opened time in descending order. */
export function listRepos(): RepoEntry[] {
  return readRegistry()
    .map((repo) => ({ ...repo, status: probe(repo.root), branch: gitBranch(repo.root) }))
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

/**
 * Do not start a git subprocess; directly read HEAD. This way, every time the repository is pulled and opened, the current branch can be obtained.
 * At the same time, it will not execute git dozens of times serially just because there are dozens of repositories in the list. `.git` is a directory.
 * The worktree/submodule is also resolved according to the gitdir pointer within it.
 */
export function gitBranch(root: string): string | null {
  try {
    const dotGit = findGitMarker(root);
    if (dotGit === null) return null;
    const stat = statSync(dotGit);
    let gitDir = dotGit;
    if (stat.isFile()) {
      const pointer = readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(pointer);
      if (!match?.[1]) return null;
      gitDir = isAbsolute(match[1]) ? match[1] : resolve(dirname(dotGit), match[1]);
    } else if (!stat.isDirectory()) {
      return null;
    }

    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s+refs\/heads\/(.+)$/.exec(head);
    if (ref?.[1]) return ref[1];
    return /^[0-9a-f]{7,64}$/i.test(head) ? `detached@${head.slice(0, 7)}` : null;
  } catch {
    return null;
  }
}

/** The scanning target can be a subdirectory of a monorepo, so look upwards to find the nearest Git root. */
function findGitMarker(root: string): string | null {
  let directory = resolve(root);
  while (true) {
    const marker = join(directory, ".git");
    if (existsSync(marker)) return marker;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function probe(root: string): RepoStatus {
  if (!isDirectory(root)) return "root-missing";
  return existsSync(indexPath(root)) ? "ok" : "index-missing";
}

// ---------------------------------------------------------------------------

/**
 * The warehouse display name takes the directory name. Repositories with the same name (two `web`) are distinguished by the full path displayed together on the interface.
 * No deduplication is done here. The basename of the root directory is empty, so it falls back to the full path.
 */
function repoDisplayName(absolute: string): string {
  return basename(absolute) || absolute;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isWellFormed(r: unknown): r is RegisteredRepo {
  if (typeof r !== "object" || r === null) return false;
  const c = r as Partial<RegisteredRepo>;
  return (
    typeof c.id === "string" &&
    typeof c.root === "string" &&
    typeof c.name === "string" &&
    typeof c.lastOpenedAt === "string"
  );
}

/**
 * First write a temporary file and then rename it.
 *
 * rename is atomic within the same file system, so what is read is always a complete version.
 * If you write by directly overwriting, when two Repolens processes start at the same time, they might write the file into a half-complete JSON.
 * And once this file gets corrupted, you have to trigger an exception every time you start it.
 */
function writeRegistry(repos: RegisteredRepo[]): void {
  const file = registryPath();
  mkdirSync(dirname(file), { recursive: true });
  const payload: RegistryFile = { version: REGISTRY_VERSION, repos };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
