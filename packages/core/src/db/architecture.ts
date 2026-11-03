import type { ArchitectureLock, LockedDependency } from "../types.js";
import type { Db } from "./database.js";

/** The layer that is treated as a 'module': those nodes on the first screen of the architecture diagram */
export interface ArchitectureModule {
  id: string;
  label: string;
  path: string;
  packageId?: number;
}

export interface ModuleDependency extends LockedDependency {
  /** The number of imports that constitute this dependency */
  count: number;
  /** Previous imports: `file:line` */
  samples: string[];
}

/**
 * Whether the repository organizes the top-level view according to multiple packages (monorepo).
 *
 * Scattered pyproject.toml / go.mod files in subdirectories such as hack/, workshops/, examples/, etc.
 * Only covers a very small part of the entire repository's source code; if only scanning detects >= 2 packages, then the package-level view of the main body of the repository is enabled.
 * Top-level directories (such as packages/ and src/ if the workspace is not declared) will disappear from the root view.
 * Therefore, it requires at least 2 packages containing source code, and the source code within the packages must cover more than half of the total number of source files and lines in the warehouse.
 */
export function hasPackageGraph(db: Db): boolean {
  const pkgStats = db.prepare(
    `SELECT COUNT(*) AS pkgs, COALESCE(SUM(files), 0) AS files, COALESCE(SUM(loc), 0) AS loc
     FROM (
       SELECT COUNT(f.id) AS files, COALESCE(SUM(f.loc), 0) AS loc
       FROM packages p
       JOIN files f ON f.package_id = p.id AND f.role = 'source'
       GROUP BY p.id
     )`,
  ).get() as { pkgs: number; files: number; loc: number };
  if (pkgStats.pkgs < 2) return false;

  const totals = db.prepare(
    `SELECT COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc
     FROM files WHERE role = 'source'`,
  ).get() as { files: number; loc: number };
  if (totals.files === 0) return false;

  return pkgStats.files * 2 >= totals.files && pkgStats.loc * 2 >= Math.max(totals.loc, 1);
}

/**
 * Module layers of the architecture: multi-package repositories are organized by package; single-package repositories are organized by directory. A common form of a single-package repository is having only one under the root directory.
 * src/, dividing by the first-level directory will only yield one module, so it follows the chain of 'only one subdirectory containing all the source code'
 * Go down until you reach a fork. AI layering, dependency locks, and inter-module dependency checks all use this same layer.
 */
export function architectureModules(db: Db): ArchitectureModule[] {
  if (hasPackageGraph(db)) {
    const packages = db.prepare(
      `SELECT p.id, p.name, p.dir, COUNT(f.id) AS files FROM packages p
       LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
       GROUP BY p.id HAVING files > 0 ORDER BY files DESC`,
    ).all() as Array<{ id: number; name: string; dir: string; files: number }>;
    return packages.map((p) => ({ id: `pkg:${p.name}`, label: p.name, path: p.dir, packageId: p.id }));
  }

  const children = db.prepare("SELECT path, name FROM directories WHERE parent_path = ? ORDER BY loc DESC");
  const sourceUnder = db.prepare(
    "SELECT COUNT(*) AS n FROM files WHERE role = 'source' AND (dir_path = ? OR path LIKE ? || '/%')",
  );
  const sourceDirectlyIn = db.prepare("SELECT COUNT(*) AS n FROM files WHERE role = 'source' AND dir_path = ?");
  let current = ".";
  for (let depth = 0; depth < 8; depth++) {
    const kids = (children.all(current) as Array<{ path: string; name: string }>)
      .filter((dir) => (sourceUnder.get(dir.path, dir.path) as { n: number }).n > 0);
    if (kids.length === 1 && (sourceDirectlyIn.get(current) as { n: number }).n === 0) {
      current = kids[0]!.path;
      continue;
    }
    return kids.slice(0, 100).map((dir) => ({ id: `dir:${dir.path}`, label: dir.name, path: dir.path }));
  }
  return [];
}

/**
 * Runtime dependencies between modules (import and HTTP requests from front-end to back-end) are only counted from source code to source code.
 * Pure type references don't count: sharing DTO types does not constitute runtime coupling, locking them will only create noise.
 */
export function moduleDependencies(db: Db, modules: readonly ArchitectureModule[] = architectureModules(db)): ModuleDependency[] {
  const keyOf = (module: ArchitectureModule) => (module.id.startsWith("pkg:") ? module.label : module.path);
  const byPackage = new Map(modules.flatMap((m) => (m.packageId === undefined ? [] : [[m.packageId, m] as const])));
  const byPath = modules.filter((m) => m.packageId === undefined).sort((a, b) => b.path.length - a.path.length);
  const owner = (path: string, packageId: number | null): ArchitectureModule | undefined =>
    byPackage.size > 0
      ? (packageId === null ? undefined : byPackage.get(packageId))
      : byPath.find((m) => path === m.path || path.startsWith(`${m.path}/`));

  const rows = db.prepare(
    `SELECT e.type, e.weight, sf.path AS srcPath, sf.package_id AS srcPackage, tf.path AS dstPath, tf.package_id AS dstPackage
     FROM edges e
     JOIN files sf ON sf.id = e.src_id
     JOIN files tf ON tf.id = e.dst_id
     WHERE e.src_kind = 'file' AND e.dst_kind = 'file' AND e.type IN ('imports', 'http')
       AND sf.role = 'source' AND tf.role = 'source'`,
  ).all() as Array<{ type: "imports" | "http"; weight: number; srcPath: string; srcPackage: number | null; dstPath: string; dstPackage: number | null }>;
  const sample = db.prepare(
    `SELECT sf.path, i.line FROM imports i JOIN files sf ON sf.id = i.file_id JOIN files tf ON tf.id = i.target_file_id
     WHERE sf.path = ? AND tf.path = ? AND i.is_type_only = 0 ORDER BY i.line LIMIT 1`,
  );

  const out = new Map<string, ModuleDependency>();
  for (const row of rows) {
    const from = owner(row.srcPath, row.srcPackage);
    const to = owner(row.dstPath, row.dstPackage);
    if (!from || !to || from.id === to.id) continue;
    const key = `${from.id}\u0000${to.id}\u0000${row.type}`;
    let dep = out.get(key);
    if (!dep) {
      dep = { from: keyOf(from), to: keyOf(to), type: row.type, count: 0, samples: [] };
      out.set(key, dep);
    }
    dep.count += row.weight;
    if (dep.samples.length < 3) {
      const hit = row.type === "imports" ? (sample.get(row.srcPath, row.dstPath) as { path: string; line: number } | undefined) : undefined;
      dep.samples.push(hit ? `${hit.path}:${hit.line}` : `${row.srcPath} → ${row.dstPath}`);
    }
  }
  return [...out.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type));
}

/** Record the current inter-module dependencies as a lock: any new dependencies that appear in the future must go through an explicit approval. */
export function buildLock(db: Db): ArchitectureLock {
  const modules = architectureModules(db);
  const level = modules.some((m) => m.id.startsWith("pkg:")) ? "package" : "directory";
  return {
    version: 1,
    level,
    modules: level === "directory" ? modules.map((m) => m.path) : [],
    dependencies: moduleDependencies(db, modules).map(({ from, to, type }) => ({ from, to, type })),
  };
}

/**
 * Look for the actual source code entry point that is exposed outside the package. `export function` only indicates that it can be exported from the current module,
 * It cannot be said that this module is the public surface of the package; treating all module exports as entry points will make utility functions
 * Flood the entry list. Node packages map to the source code according to the package.json entry, while other languages follow their own.
 * Package entry agreement handling. Go's exports are package-level semantics, so all exported functions within the package are retained.
 */
export function publicApiFileIds(db: Db): Set<number> {
  const out = packageEntryFileIds(db);

  // Barrel files usually don't have their own functions; they just expose implementations using `export * from "./foo"`.
  // Recursively expand along successfully parsed re-exports, otherwise the actual public functions will still all be missed.
  const reexports = db.prepare(
    `SELECT file_id AS sourceId, target_file_id AS targetId FROM imports
     WHERE kind = 're-export' AND target_file_id IS NOT NULL`,
  ).all() as Array<{ sourceId: number; targetId: number }>;
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of reexports) {
      if (!out.has(edge.sourceId) || out.has(edge.targetId)) continue;
      out.add(edge.targetId);
      changed = true;
    }
  }
  return out;
}

/**
 * Package's own declared entry file: package.json's exports / main / module / types mapping back to the source code,
 * Include the agreed-upon index. Excluding the re-export chain—other packages should import from these paths, not bypass them to import.
 * The internally exported files still bypassed the interface.
 */
export function packageEntryFileIds(db: Db): Set<number> {
  const packages = db.prepare(
    "SELECT id, dir, entry_points AS entryPoints FROM packages",
  ).all() as Array<{ id: number; dir: string; entryPoints: string }>;
  const files = db.prepare(
    "SELECT id, path, language, package_id AS packageId FROM files",
  ).all() as Array<{ id: number; path: string; language: string; packageId: number | null }>;
  const entryMatchers = new Map<number, RegExp[]>();
  for (const pkg of packages) {
    const entries = parseStrings(pkg.entryPoints)
      .filter((entry) => entry !== "package.json")
      .flatMap(sourceEntryCandidates);
    entryMatchers.set(pkg.id, [...new Set(entries)].map(pathPattern));
  }

  const out = new Set<number>();
  for (const file of files) {
    if (file.language === "go") {
      out.add(file.id);
      continue;
    }
    const relative = packageRelativePath(file.path, file.packageId, packages);
    const conventional = /^(?:src\/)?(?:index\.(?:[cm]?[jt]sx?|py)|__init__\.py|lib\.rs|mod\.rs)$/.test(relative);
    const configured = file.packageId !== null &&
      (entryMatchers.get(file.packageId) ?? []).some((matcher) => matcher.test(relative));
    if (conventional || configured) out.add(file.id);
  }
  return out;
}

function packageRelativePath(
  filePath: string,
  packageId: number | null,
  packages: readonly { id: number; dir: string }[],
): string {
  const dir = packages.find((pkg) => pkg.id === packageId)?.dir;
  if (!dir || dir === ".") return filePath;
  return filePath.startsWith(`${dir}/`) ? filePath.slice(dir.length + 1) : filePath;
}

/** The release entry points such as dist/foo.js and dist/foo.d.ts are all mapped back to the source code family of src/foo. */
function sourceEntryCandidates(entry: string): string[] {
  const clean = entry.startsWith("./") ? entry.slice(2) : entry;
  const source = clean.startsWith("dist/") || clean.startsWith("build/")
    ? `src/${clean.slice(clean.indexOf("/") + 1)}`
    : clean;
  const stem = source.replace(/(?:\.d)?\.(?:[cm]?js|tsx?|jsx|py|rs|go)$/, "");
  return [
    source,
    `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`,
    `${stem}.py`, `${stem}.rs`, `${stem}.go`,
  ];
}

function pathPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function parseStrings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Module dependencies that are not in the lock. When the lock records a directory module, it is divided according to the directories in the lock, not according to what is calculated now:
 * If the directory structure changes, the lock should be regenerated; you can't quietly switch to a new structure to hide the new dependencies.
 */
export function unapprovedDependencies(db: Db, lock: ArchitectureLock): ModuleDependency[] {
  const modules: ArchitectureModule[] = lock.level === "package"
    ? architectureModules(db).filter((m) => m.id.startsWith("pkg:"))
    : lock.modules.map((path) => ({ id: `dir:${path}`, label: path.split("/").at(-1) ?? path, path }));
  if (lock.level === "package" && modules.length < 2) return [];
  const approved = new Set(lock.dependencies.map((d) => `${d.from}\u0000${d.to}\u0000${d.type}`));
  return moduleDependencies(db, modules).filter((dep) => !approved.has(`${dep.from}\u0000${dep.to}\u0000${dep.type}`));
}
