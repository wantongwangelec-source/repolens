import ignoreFactory from "ignore";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * No matter how `.gitignore` is written, the directory should not be added to the index.
 * It is listed separately because many repositories do not include these in `.gitignore` (for example, nested node_modules in a monorepo).
 */
export const HARD_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "web_modules",
  ".repolens",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode-test",
  ".turbo",
  ".nx",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  "target", // Rust build artifacts; never contains source code in Cargo projects
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  "coverage",
]);

export interface IgnoreMatcher {
  /** The path is a repository-relative POSIX path; directories must end with `/` to match the directory rule */
  ignores: (repoRelPath: string) => boolean;
}

/**
 * Combine the repository root’s `.gitignore`, `.repolensignore`, and the user-configured exclude/include.
 *
 * Only read the root-level ignore file, do not recursively collect `.gitignore` files from subdirectories: the latter requires directory-level hierarchical matching.
 * The complexity is considerable, while the actual benefits are limited—the vast majority of ignored paths are blocked by HARD_IGNORED_DIRS.
 */
export function buildIgnoreMatcher(
  repoRoot: string,
  exclude: string[],
  include: string[],
): IgnoreMatcher {
  const rootGit = readIgnoreFile(join(repoRoot, ".gitignore"));
  const repolens = readIgnoreFile(join(repoRoot, ".repolensignore"));
  const configured = ignoreFactory();
  if (exclude.length > 0) configured.add(exclude);
  // The ignore package uses `!pattern` to express inverse exemptions, placed at the end to override the previous rules.
  if (include.length > 0) configured.add(include.map((p) => (p.startsWith("!") ? p : `!${p}`)));

  // Each subdirectory can have its own .gitignore. Read and cache as needed, which is in line with Git's
  // The semantics of 'rules relative to the current directory' also do not require traversing the entire repository in advance.
  const nested = new Map<string, ReturnType<typeof ignoreFactory> | null>();
  const nestedIgnore = (scope: string) => {
    if (nested.has(scope)) return nested.get(scope) ?? null;
    const loaded = readIgnoreFile(join(repoRoot, ...scope.split("/"), ".gitignore"));
    nested.set(scope, loaded);
    return loaded;
  };

  return {
    ignores(repoRelPath: string): boolean {
      if (repoRelPath === "" || repoRelPath === ".") return false;
      try {
        let ignored = applyIgnore(false, rootGit, repoRelPath);
        const clean = repoRelPath.endsWith("/") ? repoRelPath.slice(0, -1) : repoRelPath;
        const parts = clean.split("/");
        // Check the .gitignore in all parent directories of the path; the directory's own rules only apply to its contents.
        // Cannot determine whether this directory itself is traversed by the parent.
        for (let depth = 1; depth < parts.length; depth++) {
          const scope = parts.slice(0, depth).join("/");
          const localPath = repoRelPath.slice(scope.length + 1);
          ignored = applyIgnore(ignored, nestedIgnore(scope), localPath);
        }
        // RepoLens-specific rules and explicit configurations have the highest priority.
        ignored = applyIgnore(ignored, repolens, repoRelPath);
        return applyIgnore(ignored, configured, repoRelPath);
      } catch {
        return false;
      }
    },
  };
}

function readIgnoreFile(path: string): ReturnType<typeof ignoreFactory> | null {
  if (!existsSync(path)) return null;
  return ignoreFactory().add(readFileSync(path, "utf8"));
}

function applyIgnore(
  current: boolean,
  matcher: ReturnType<typeof ignoreFactory> | null,
  path: string,
): boolean {
  if (matcher === null || path === "") return current;
  const result = matcher.test(path);
  if (result.ignored) return true;
  if (result.unignored) return false;
  return current;
}
