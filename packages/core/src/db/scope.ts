import { baseName } from "../resolve/path-utils.js";
import type { FileRole } from "../types.js";
import type { Db } from "./database.js";

/** The space a graph node occupies in the repository */
export interface NodeScope {
  id: string;
  kind: "repo" | "package" | "directory" | "file" | "symbol";
  label: string;
  /** Relative path of the repository; the repository root is ".", the symbol takes the location of the file */
  path: string;
  packageId: number | null;
  /** File ID within the scope */
  files: Set<number>;
  /** The id of the symbol node itself */
  symbolId: number | null;
}

const ALL_ROLES: readonly FileRole[] = ["source", "test", "config", "generated", "types", "docs", "asset", "vendor"];

/**
 * Replace the node id with the file it covers. Packages are grouped by ownership (package_id), directories by path prefix, and files are themselves.
 * Get the file where the symbol is located. Return null for unrecognizable id. Use substr instead of LIKE to compare the prefix: underscores in directory names.
 * Will be treated as a wildcard by LIKE.
 */
export function resolveScope(db: Db, nodeId: string, roles: readonly FileRole[] = ["source"]): NodeScope | null {
  const roleList = roles.length > 0 ? roles : ALL_ROLES;
  const placeholders = roleList.map(() => "?").join(",");
  const ids = (sql: string, ...args: unknown[]) =>
    new Set((db.prepare(`SELECT id FROM files WHERE role IN (${placeholders}) AND ${sql}`).all(...roleList, ...args) as Array<{ id: number }>)
      .map((row) => row.id));

  if (nodeId === "dir:." || nodeId === "repo") {
    return { id: "dir:.", kind: "repo", label: "repo", path: ".", packageId: null, files: ids("1 = 1"), symbolId: null };
  }
  if (nodeId.startsWith("pkg:")) {
    const pkg = db.prepare("SELECT id, name, dir FROM packages WHERE name = ?").get(nodeId.slice(4)) as
      | { id: number; name: string; dir: string } | undefined;
    if (!pkg) return null;
    return { id: nodeId, kind: "package", label: pkg.name, path: pkg.dir, packageId: pkg.id, files: ids("package_id = ?", pkg.id), symbolId: null };
  }
  if (nodeId.startsWith("dir:")) {
    const path = nodeId.slice(4);
    return {
      id: nodeId, kind: "directory", label: baseName(path), path, packageId: null,
      files: ids("substr(path, 1, length(?) + 1) = ? || '/'", path, path), symbolId: null,
    };
  }
  if (nodeId.startsWith("file:")) {
    const file = db.prepare("SELECT id, path, package_id AS packageId FROM files WHERE id = ?").get(Number(nodeId.slice(5))) as
      | { id: number; path: string; packageId: number | null } | undefined;
    if (!file) return null;
    return { id: nodeId, kind: "file", label: baseName(file.path), path: file.path, packageId: file.packageId, files: new Set([file.id]), symbolId: null };
  }
  if (nodeId.startsWith("sym:")) {
    const symbol = db.prepare(
      `SELECT s.id, s.name, s.container, f.id AS fileId, f.path, f.package_id AS packageId
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    ).get(Number(nodeId.slice(4))) as
      | { id: number; name: string; container: string | null; fileId: number; path: string; packageId: number | null } | undefined;
    if (!symbol) return null;
    return {
      id: nodeId, kind: "symbol", label: symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name,
      path: symbol.path, packageId: symbol.packageId, files: new Set([symbol.fileId]), symbolId: symbol.id,
    };
  }
  return null;
}

/** Functions involved in statistics within the scope: functions and methods implemented in the source code; the symbol node is itself */
export function scopeFunctions(db: Db, scope: NodeScope): Array<{ id: number; fileId: number; hash: string; complexity: number }> {
  if (scope.symbolId !== null) {
    return db.prepare("SELECT id, file_id AS fileId, hash, complexity FROM symbols WHERE id = ?").all(scope.symbolId) as Array<{
      id: number; fileId: number; hash: string; complexity: number;
    }>;
  }
  return inBatches([...scope.files], (batch) => db.prepare(
    `SELECT s.id, s.file_id AS fileId, s.hash, s.complexity FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.role = 'source' AND s.kind IN ('function', 'method') AND s.implemented = 1
       AND s.file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; fileId: number; hash: string; complexity: number }>);
}

/** SQLite has a limit on the number of parameters, so query in large batches */
export function inBatches<T, R>(items: readonly T[], run: (batch: T[]) => R[], size = 400): R[] {
  const out: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) out.push(...run(items.slice(offset, offset + size)));
  return out;
}
