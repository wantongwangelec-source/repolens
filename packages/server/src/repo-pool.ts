import {
  dropSemanticsFromOutdatedInput,
  indexPath,
  gitBranch,
  listRepos,
  openDb,
  probe,
  repoId,
  semanticInputOutdated,
  type Db,
  type RepoEntry,
} from "@repolens/core";
import type { Hono } from "hono";
import { basename, resolve } from "node:path";
import { createApi } from "./api.js";

export class RepoUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

interface PooledRepo {
  id: string;
  root: string;
  db: Db;
  /** The API sub-application of this repository */
  api: Hono;
  usedAt: number;
}

/**
 * Pool that holds read-only connections according to the repository.
 *
 * The interface should be able to switch repositories, but `createApi` is a closure over a db. Two ways to modify it: use db
 * Change to fetching at each route (affecting all ten endpoints), or one API sub-application per repository,
 * Distribute according to the request in the outer layer (no need to change a line in api.ts). Choose the latter.
 *
 * **Reachable range is the safety boundary**: Only warehouses listed in the inventory can be opened, or those specified at startup
 * That. The API does not accept arbitrary paths submitted from the web — `/source` will read the source code from the root of the repository if
 * Allowing paths to be specified on-site means that anything that can connect to this port can read any file on the machine.
 * The new repository can only be added to the list through the command line or the native system directory picker directly invoked by the server.
 */
export class RepoPool {
  private readonly open = new Map<string, PooledRepo>();
  private readonly defaultId: string | null;
  private readonly defaultRoot: string | null;

  /**
   * @param defaultRoot The repository specified at startup; all default requests go to it; null means only according to
   *   The list provides the warehouse; requests must include the warehouse ID.
   * @param maxOpen The maximum number of open connections at the same time. Each connection occupies a file descriptor and
   *   WAL mapping, clicking through twenty warehouses shouldn't accumulate twenty handles; after exceeding, follow the least recently used
   *   Off. The repository specified at startup is permanently resident and does not participate in eviction.
   */
  constructor(
    defaultRoot: string | null,
    private readonly maxOpen = 4,
  ) {
    this.defaultRoot = defaultRoot === null ? null : resolve(defaultRoot);
    this.defaultId = this.defaultRoot === null ? null : repoId(this.defaultRoot);
  }

  get currentId(): string | null {
    return this.defaultId;
  }

  /**
   * The list + that repository at startup.
   *
   * The initialized repository needs to be handled separately: writing the inventory may fail because the home directory is not writable.
   * In that case, the interface at least still needs to be able to show what you are currently looking at.
   */
  list(): RepoEntry[] {
    const entries = listRepos();
    const { defaultId, defaultRoot } = this;
    if (defaultId !== null && defaultRoot !== null && !entries.some((e) => e.id === defaultId)) {
      entries.unshift({
        id: defaultId,
        root: defaultRoot,
        name: basename(defaultRoot) || defaultRoot,
        lastOpenedAt: new Date().toISOString(),
        status: probe(defaultRoot),
        branch: gitBranch(defaultRoot),
      });
    }
    return entries;
  }

  /** Only allow restoring the repository ID from the startup repository or the inventory repository into a path, for use as a safe rescan entry point. */
  root(id: string): string {
    return this.rootOf(id);
  }

  /** Parse the repository identifier; if not specified, use the one from startup. If it cannot be opened, throw RepoUnavailableError. */
  resolve(id: string | undefined): PooledRepo {
    const target = id === undefined || id === "" ? this.defaultId : id;
    if (target === null) throw new RepoUnavailableError("还没有打开任何仓库", 404);

    const cached = this.open.get(target);
    if (cached) {
      cached.usedAt = Date.now();
      return cached;
    }

    const root = this.rootOf(target);
    const status = probe(root);
    if (status === "root-missing") {
      throw new RepoUnavailableError(`仓库目录不存在：${root}`, 404);
    }
    if (status === "index-missing") {
      throw new RepoUnavailableError(`该仓库尚未建立索引，先运行 \`repolens scan ${root}\``, 404);
    }

    const db = openDb(indexPath(root), { readonly: true });
    // Read-only connections have already confirmed the index version; if a writable openDb encounters a version mismatch, it will rebuild the index, so it cannot be opened first.
    if (semanticInputOutdated(db)) refreshSemanticCache(root);
    const entry: PooledRepo = {
      id: target,
      root,
      db,
      api: createApi({ db, repoRoot: root }),
      usedAt: Date.now(),
    };
    this.open.set(target, entry);
    this.evictIfNeeded();
    return entry;
  }

  close(): void {
    for (const entry of this.open.values()) entry.db.close();
    this.open.clear();
  }

  private rootOf(id: string): string {
    if (id === this.defaultId && this.defaultRoot !== null) return this.defaultRoot;
    const found = listRepos().find((r) => r.id === id);
    if (!found) throw new RepoUnavailableError(`未知的仓库标识：${id}`, 400);
    return found.root;
  }

  private evictIfNeeded(): void {
    while (this.open.size > this.maxOpen) {
      let oldest: PooledRepo | null = null;
      for (const entry of this.open.values()) {
        if (entry.id === this.defaultId) continue;
        if (oldest === null || entry.usedAt < oldest.usedAt) oldest = entry;
      }
      if (oldest === null) return;
      oldest.db.close();
      this.open.delete(oldest.id);
    }
  }
}

/**
 * The old cache is just not accurate enough and not worth keeping the repository from opening: cleanup failed (for example, the scan is still in progress
 * (Write lock) will be skipped. The version tag was not written and will be attempted again next time it is opened.
 */
function refreshSemanticCache(root: string): void {
  let writeDb: Db | null = null;
  try {
    writeDb = openDb(indexPath(root));
    dropSemanticsFromOutdatedInput(writeDb, root);
  } catch {
  } finally {
    writeDb?.close();
  }
}
