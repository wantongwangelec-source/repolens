import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { forgetRepo, indexPath, isIndexCurrent } from "@repolens/core";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_HEADER, sameToken } from "./auth.js";
import { DirectoryPickerUnavailableError, pickDirectory } from "./directory-picker.js";
import { LiveUpdates } from "./live.js";
import { RepoPool, RepoUnavailableError } from "./repo-pool.js";
import { InvalidScanRootError, ScanBusyError, ScanManager } from "./scan-manager.js";

export { createApi, type ApiDeps } from "./api.js";
export { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_HEADER } from "./auth.js";
export { RepoPool, RepoUnavailableError } from "./repo-pool.js";

/**
 * Default port.
 *
 * Deliberately avoid commonly used ports such as 5173 (Vite dev), 3000, and 8080.
 * Also avoid 5000 / 7000 (the default ports used by AirPlay receivers on macOS).
 */
export const DEFAULT_PORT = 7173;

export interface ServeOptions {
  /** The repository where default requests are directed. null means repositories are provided only according to the list; the list may be empty when the desktop client starts for the first time. */
  repoRoot: string | null;
  /** Transmit 0 uses a system-assigned free port, the actual port can be found in the return value */
  port: number;
  host?: string;
  /** Frontend build output directory; if not specified, automatically locate the dist of @repolens/web */
  webRoot?: string;
  /** Replace the built-in system directory selector, use it on the desktop to pop up the native dialog */
  pickDirectory?: () => Promise<string | null>;
  /**
   * After setting it, every /api request must include this token through a cookie or request header.
   *
   * 127.0.0.1 is reachable by all programs on the same machine, as well as any web page opened in a browser;
   * Command-line users can accept starting the service themselves in the terminal, but desktop applications running in the background cannot.
   */
  accessToken?: string;
  /** Monitor the file changes in the startup repository at launch, and automatically refresh the structure index after changes */
  watch?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const repoRoot = options.repoRoot === null ? null : resolve(options.repoRoot);
  if (repoRoot !== null) {
    const dbPath = indexPath(repoRoot);
    if (!existsSync(dbPath)) {
      throw new Error(`索引不存在：${dbPath}\n先运行 \`repolens scan ${options.repoRoot}\``);
    }
    if (!isIndexCurrent(dbPath)) {
      throw new Error(`索引版本过期：${dbPath}\n运行 \`repolens scan ${options.repoRoot}\` 更新索引`);
    }
  }

  const pool = new RepoPool(repoRoot);
  const scans = new ScanManager();
  const live = new LiveUpdates(scans);
  const pick = options.pickDirectory ?? pickDirectory;
  const app = new Hono();

  // Hono defaults to swallowing exceptions into a single 'Internal Server Error'. This is a local tool,
  // Error messages must appear both in the terminal and in the response, otherwise troubleshooting can only rely on guesses.
  app.onError((err, c) => {
    console.error(`[repolens] ${c.req.method} ${c.req.path} 失败：`, err);
    return c.json({ error: err.message }, 500);
  });

  const accessToken = options.accessToken;
  if (accessToken !== undefined) {
    app.use("/api/*", async (c, next) => {
      const provided = c.req.header(ACCESS_TOKEN_HEADER) ?? getCookie(c, ACCESS_TOKEN_COOKIE);
      if (provided === undefined || !sameToken(provided, accessToken)) {
        return c.json({ error: "缺少访问令牌" }, 401);
      }
      await next();
    });
  }

  // The warehouse inventory itself does not belong to any warehouse, so it is not distributed according to the warehouse below.
  // It must be registered before distribution, otherwise it will be taken by /api/* and then result in a 404 in the sub-application.
  app.get("/api/repos", (c) => c.json({ current: pool.currentId, repos: pool.list() }));

  // The path is not submitted by the browser: this endpoint invokes the system directory picker in the service process and
  // Directly hand over the selection result to the scanner, avoiding the creation of a new HTTP API that can read any absolute path.
  app.post("/api/repos/pick-and-scan", async (c) => {
    if (c.req.header("x-repolens-intent") !== "scan-repository") {
      return c.json({ error: "缺少仓库扫描确认标记" }, 403);
    }

    try {
      const selected = await pick();
      if (selected === null) return c.json({ cancelled: true });
      return c.json({ cancelled: false, task: scans.start(selected) });
    } catch (err) {
      if (err instanceof ScanBusyError) return c.json({ error: err.message }, 409);
      if (err instanceof InvalidScanRootError) return c.json({ error: err.message }, 400);
      if (err instanceof DirectoryPickerUnavailableError) return c.json({ error: err.message }, 501);
      throw err;
    }
  });

  app.get("/api/repo-scans", (c) => c.json({ tasks: scans.list() }));

  app.get("/api/repo-scans/:id", (c) => {
    const task = scans.get(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "扫描任务不存在或服务已经重启" }, 404);
  });

  app.post("/api/repos/:id/scan", (c) => {
    if (c.req.header("x-repolens-intent") !== "scan-repository") {
      return c.json({ error: "缺少仓库扫描确认标记" }, 403);
    }
    try {
      // The browser only submits the short IDs in the list and does not accept absolute paths, to avoid turning the rescan interface into
      // Arbitrary directory read entry. Even if an index already exists, an incremental scan must actually be performed once.
      return c.json(scans.start(pool.root(c.req.param("id")), { scanExisting: true }));
    } catch (err) {
      if (err instanceof ScanBusyError) return c.json({ error: err.message }, 409);
      if (err instanceof InvalidScanRootError) return c.json({ error: err.message }, 400);
      if (err instanceof RepoUnavailableError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  live.mount(app, pool);

  // Only remove from the list, without touching the repository and index. If the repository is deleted or moved, dead entries will remain in the list.
  // Without this endpoint, you can only manually edit ~/.repolens/repos.json.
  app.delete("/api/repos/:id", (c) => {
    const id = c.req.param("id");
    if (id === pool.currentId) {
      return c.json({ error: "不能移除当前正在浏览的仓库" }, 400);
    }
    return forgetRepo(id) ? c.json({ removed: id }) : c.json({ error: "清单里没有这个仓库" }, 404);
  });

  // Distribute to the corresponding repository's API sub-application according to `?repo=<id>`, defaulting to the repository at startup.
  // Using query parameters instead of a path prefix is to make it available by default: the frontend's first screen does not need to fetch the list once first.
  // Only then did I dare to send the first request, and curl could still be typed as before.
  app.all("/api/*", (c) => {
    let entry;
    try {
      entry = pool.resolve(c.req.query("repo"));
    } catch (err) {
      if (err instanceof RepoUnavailableError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice("/api".length) || "/";
    return entry.api.fetch(new Request(url, c.req.raw));
  });

  const webRoot = options.webRoot ?? locateWebRoot();
  if (webRoot !== null) {
    const root = resolve(webRoot);
    app.use("/*", serveStatic({ root }));
    // SPA Fallback: All non-/api unmatched paths return index.html
    app.get("*", serveStatic({ path: join(root, "index.html") }));
  } else {
    app.get("/", (c) =>
      c.text("前端尚未构建。运行 `pnpm --filter @repolens/web build` 后重启，或用 `pnpm dev:web` 起开发服务器。"),
    );
  }

  const host = options.host ?? "127.0.0.1";
  const { server, port } = await listen(app, options.port, host);
  if (options.watch && repoRoot !== null && pool.currentId !== null) live.watch(pool.currentId, repoRoot);

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    port,
    close: () =>
      new Promise<void>((done) => {
        live.close();
        server.close(() => {
          void scans.close().finally(() => {
            pool.close();
            done();
          });
        });
        // close() only stops accepting new connections. Browser long connections and the ongoing output streams of follow-up questions will still keep it
        // Keep waiting, and disconnect directly when exiting.
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  };
}

function locateWebRoot(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("@repolens/web/package.json");
    const dist = resolve(dirname(pkgPath), "dist");
    return existsSync(resolve(dist, "index.html")) ? dist : null;
  } catch {
    return null;
  }
}

function listen(app: Hono, port: number, hostname: string) {
  return new Promise<{ server: ReturnType<typeof serve>; port: number }>((done, fail) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
      server.off("error", fail);
      done({ server, port: info.port });
    });
    server.once("error", fail);
  });
}
