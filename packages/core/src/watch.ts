import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, LOCK_FILENAME, loadConfig } from "./config.js";
import { buildIgnoreMatcher, HARD_IGNORED_DIRS } from "./discovery/ignore.js";

const CONVENTION_FILES = new Set([CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, LOCK_FILENAME]);

/**
 * When monitoring changes in files, which modifications are worth refreshing the index for. Ignore rules and scanning consistency; conventions under the root directory,
 * Even if personal configurations and dependency locks are ignored by .gitignore, the inspection conclusions are determined by them.
 * `file` is the relative path reported by fs.watch, and when the platform does not provide a path, it is treated as 'possibly related.'
 */
export function indexChangeFilter(root: string): (file: string | null) => boolean {
  const config = loadConfig(root);
  const ignore = buildIgnoreMatcher(root, config.exclude, config.include);
  return (file) => {
    if (!file) return true;
    const parts = file.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1 && CONVENTION_FILES.has(parts[0]!)) return true;
    if (parts.some((part) => HARD_IGNORED_DIRS.has(part))) return false;
    return !ignore.ignores(parts.join("/"));
  };
}
