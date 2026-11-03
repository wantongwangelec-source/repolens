import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { DiscoveredFile, DiscoveredPackage, RepolensConfig } from "../types.js";
import { buildIgnoreMatcher, HARD_IGNORED_DIRS } from "./ignore.js";
import { detectLanguage } from "./language.js";
import { createRoleClassifier } from "./roles.js";

export interface WalkResult {
  files: DiscoveredFile[];
  /** All directories that have appeared (relative to the repository in POSIX, excluding the root) */
  directories: string[];
  skippedTooLarge: number;
}

/**
 * Traverse the repository and perform language detection, role classification, and content hashing for each file.
 *
 * The hash is calculated here, not during the parsing stage: incremental scanning relies on it to determine if the file has changed.
 * And files that 'haven't changed' don't need to be read a second time at all.
 */
export function walkRepo(
  repoRoot: string,
  config: RepolensConfig,
  packages: readonly DiscoveredPackage[],
): WalkResult {
  const ignore = buildIgnoreMatcher(repoRoot, config.exclude, config.include);
  const classify = createRoleClassifier(config.roleOverrides);
  const packageDirs = [...packages]
    .map((p) => p.dir)
    .sort((a, b) => b.length - a.length); // Longest prefix first, nested packages belong to the innermost layer

  const files: DiscoveredFile[] = [];
  const directories = new Set<string>();
  let skippedTooLarge = 0;

  const visit = (absDir: string, relDir: string): void => {
    for (const entry of readdirSafe(absDir)) {
      const name = entry.name;
      const rel = relDir === "" ? name : `${relDir}/${name}`;

      if (entry.isSymbolicLink()) continue; // Soft links can cause loops, skip them directly

      if (entry.isDirectory()) {
        if (HARD_IGNORED_DIRS.has(name)) continue;
        if (ignore.ignores(`${rel}/`)) continue;
        directories.add(rel);
        visit(join(absDir, name), rel);
        continue;
      }

      if (!entry.isFile()) continue;
      if (ignore.ignores(rel)) continue;

      const language = detectLanguage(rel);
      const pathRole = classify(rel, language);
      if (pathRole === "vendor") continue;

      const abs = join(absDir, name);
      let bytes: number;
      try {
        bytes = statSync(abs).size;
      } catch {
        continue;
      }

      if (bytes > config.maxFileBytes) {
        skippedTooLarge++;
        continue;
      }

      // Non-resource files need to read content to calculate incremental fingerprints, and conveniently check the generation mark at the beginning.
      // Do not add an extra disk read. When the path is clearly classified, content rules are not allowed to override it.
      const content = pathRole === "asset" ? null : readFileSafe(abs);
      const role = pathRole === "source" && content !== null
        ? classify(rel, language, content.subarray(0, 12_000).toString("utf8"))
        : pathRole;
      const hash = content === null ? `size:${bytes}` : hashContent(content);

      files.push({
        path: rel,
        language,
        role,
        bytes,
        hash,
        packageDir: packageDirs.find((dir) => dir === "." || rel.startsWith(`${dir}/`)) ?? null,
      });
    }
  };

  visit(repoRoot, "");

  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    directories: [...directories].sort(),
    skippedTooLarge,
  };
}

function readdirSafe(absDir: string): Dirent[] {
  try {
    return readdirSync(absDir, { withFileTypes: true });
  } catch {
    // Insufficient permissions or race condition deletions should not interrupt the entire traversal
    return [];
  }
}

function readFileSafe(abs: string): Buffer {
  try {
    return readFileSync(abs);
  } catch {
    return Buffer.alloc(0);
  }
}

export function hashContent(content: Buffer | string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}
