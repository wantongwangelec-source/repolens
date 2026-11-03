import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Locate front-end build artifacts.
 *
 * Look up by the CLI rather than the server: the server is purely an API layer, let it reverse
 * Relying on the UI package will reverse the direction of dependencies. The CLI is the final deliverable, and it is its responsibility to know where the UI is.
 */
export function locateWebDist(): string | null {
  const candidates: string[] = [];

  try {
    candidates.push(resolve(dirname(require.resolve("@repolens/web/package.json")), "dist"));
  } catch {
    // Use the following relative path as a fallback when the workspace link is not installed
  }

  // Direct runtime location from source code within the monorepo: packages/cli/dist/../../web/dist
  candidates.push(resolve(dirname(new URL(import.meta.url).pathname), "../../web/dist"));

  return candidates.find((dir) => existsSync(resolve(dir, "index.html"))) ?? null;
}

export function webAssetsHint(): string {
  return "前端尚未构建，运行 `pnpm --filter @repolens/web build` 后重试。";
}
