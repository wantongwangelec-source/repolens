import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import picomatch from "picomatch";
import type { DiscoveredPackage, PackageManager } from "../types.js";
import { HARD_IGNORED_DIRS } from "./ignore.js";

/**
 * Check monorepo package boundaries.
 *
 * Why not use algorithmic clustering: the 'organization' strategy in docs/INTERACTION.md requires that groups must be
 * The structures that already exist in the user's mind. The workspace boundaries declared by the repository itself are the most authoritative answer.
 * No matter how beautiful the community division you guessed is, it can't compare to it.
 */
export function discoverPackages(repoRoot: string): DiscoveredPackage[] {
  const found = new Map<string, DiscoveredPackage>();
  const add = (pkg: DiscoveredPackage) => {
    const existing = found.get(pkg.dir);
    // When the same directory is hit by multiple managers, keep the one with more complete information
    if (!existing || existing.entryPoints.length < pkg.entryPoints.length) {
      found.set(pkg.dir, pkg);
    }
  };

  for (const pkg of detectNodeWorkspace(repoRoot)) add(pkg);
  for (const pkg of detectGoModules(repoRoot)) add(pkg);
  for (const pkg of detectCargo(repoRoot)) add(pkg);
  for (const pkg of detectPython(repoRoot)) add(pkg);

  return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

// ---------------------------------------------------------------------------
// Node: pnpm-workspace.yaml / package.json workspaces
// ---------------------------------------------------------------------------

function detectNodeWorkspace(repoRoot: string): DiscoveredPackage[] {
  const rootPkgPath = join(repoRoot, "package.json");
  if (!existsSync(rootPkgPath)) return [];

  const rootPkg = readJson(rootPkgPath);
  if (!rootPkg) return [];

  const manager = detectNodeManager(repoRoot);
  const globs = workspaceGlobs(repoRoot, rootPkg);

  // A repository without a workspace declaration is a single-package repository
  if (globs.length === 0) {
    return [nodePackage(repoRoot, ".", rootPkg, manager)];
  }

  const out: DiscoveredPackage[] = [];
  const isRootPrivate = rootPkg["private"] === true;
  if (!isRootPrivate) out.push(nodePackage(repoRoot, ".", rootPkg, manager));

  for (const dir of expandGlobs(repoRoot, globs)) {
    const pkgJson = readJson(join(repoRoot, dir, "package.json"));
    if (pkgJson) out.push(nodePackage(repoRoot, dir, pkgJson, manager));
  }
  return out;
}

function detectNodeManager(repoRoot: string): PackageManager {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml")) || existsSync(join(repoRoot, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

function workspaceGlobs(repoRoot: string, rootPkg: Record<string, unknown>): string[] {
  const pnpmPath = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      const doc = parseYaml(readFileSync(pnpmPath, "utf8")) as { packages?: unknown };
      if (Array.isArray(doc?.packages)) {
        return doc.packages.filter((p): p is string => typeof p === "string");
      }
    } catch {
      // A broken configuration shouldn't cause the entire scan to fail; it should degrade to a single package.
    }
  }

  const ws = rootPkg["workspaces"];
  if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === "string");
  if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    return ((ws as { packages: unknown[] }).packages).filter((p): p is string => typeof p === "string");
  }
  return [];
}

function nodePackage(
  repoRoot: string,
  dir: string,
  pkgJson: Record<string, unknown>,
  manager: PackageManager,
): DiscoveredPackage {
  const name = typeof pkgJson["name"] === "string" ? pkgJson["name"] : dir === "." ? basename(repoRoot) : dir;
  return {
    name,
    dir,
    manager,
    version: typeof pkgJson["version"] === "string" ? pkgJson["version"] : undefined,
    entryPoints: nodeEntryPoints(pkgJson),
  };
}

/**
 * Collect entry candidates from package.json.
 * These paths are treated in M4 as the starting point of the 'external API entry' and are also used to resolve workspace package name imports.
 */
export function nodeEntryPoints(pkgJson: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.startsWith(".")) out.add(v.replace(/^\.\//, ""));
  };

  push(pkgJson["main"]);
  push(pkgJson["module"]);
  push(pkgJson["types"]);
  push(pkgJson["typings"]);

  const walkExports = (node: unknown): void => {
    if (typeof node === "string") return push(node);
    if (!node || typeof node !== "object") return;
    for (const value of Object.values(node as Record<string, unknown>)) walkExports(value);
  };
  walkExports(pkgJson["exports"]);

  const bin = pkgJson["bin"];
  if (typeof bin === "string") push(bin);
  else if (bin && typeof bin === "object") {
    for (const value of Object.values(bin as Record<string, unknown>)) push(value);
  }

  return [...out];
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function detectGoModules(repoRoot: string): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const dir of findFilesNamed(repoRoot, "go.mod", 4)) {
    const content = readTextSafe(join(repoRoot, dir, "go.mod"));
    if (content === null) continue;
    const m = /^\s*module\s+(\S+)/m.exec(content);
    if (!m?.[1]) continue;
    out.push({
      name: m[1],
      dir,
      manager: "go",
      entryPoints: existsSync(join(repoRoot, dir, "main.go")) ? ["main.go"] : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rust / Cargo
// ---------------------------------------------------------------------------

function detectCargo(repoRoot: string): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const dir of findFilesNamed(repoRoot, "Cargo.toml", 4)) {
    const content = readTextSafe(join(repoRoot, dir, "Cargo.toml"));
    if (content === null) continue;

    let doc: Record<string, unknown>;
    try {
      doc = parseToml(content) as Record<string, unknown>;
    } catch {
      continue;
    }

    const pkg = doc["package"] as { name?: unknown; version?: unknown } | undefined;
    if (typeof pkg?.name === "string") {
      out.push({
        name: pkg.name,
        dir,
        manager: "cargo",
        version: typeof pkg.version === "string" ? pkg.version : undefined,
        entryPoints: cargoEntryPoints(repoRoot, dir, doc),
      });
    }

    // The members in workspace.members will be hit individually during iteration, here we only cover the case of pure virtual manifests.
    const ws = doc["workspace"] as { members?: unknown } | undefined;
    if (Array.isArray(ws?.members)) {
      const members = ws.members.filter((m): m is string => typeof m === "string");
      for (const memberDir of expandGlobs(repoRoot, members.map((m) => joinPosix(dir, m)))) {
        if (!existsSync(join(repoRoot, memberDir, "Cargo.toml"))) continue;
        const memberDoc = readTextSafe(join(repoRoot, memberDir, "Cargo.toml"));
        if (memberDoc === null) continue;
        try {
          const parsed = parseToml(memberDoc) as Record<string, unknown> & {
            package?: { name?: unknown };
          };
          if (typeof parsed.package?.name === "string") {
            out.push({
              name: parsed.package.name,
              dir: memberDir,
              manager: "cargo",
              entryPoints: cargoEntryPoints(repoRoot, memberDir, parsed as Record<string, unknown>),
            });
          }
        } catch {
          // Ignore the list of broken members
        }
      }
    }
  }
  return out;
}

/**
 * The entry file of the crate.
 *
 * The conventional layout is `src/lib.rs` / `src/main.rs`, but Cargo allows `[lib]` and `[[bin]]`
 * Use `path` to point to any location, and the directory at that location is the crate root of that target——
 * `crate::a::b` should be looked for from there downward, not from `src/`. ripgrep works exactly like this:
 * According to the package declaration `[[bin]] path = "crates/core/main.rs"`, therefore `crate::flags::lowargs`
 * Falls in `crates/core/flags/lowargs.rs`. Forcing `src/` would cause large numbers of imports in this type of repository to fail to resolve.
 *
 * Only recognize explicit declarations, not automatically discovered targets like `src/bin/*.rs`: they are not in the manifest.
 * And each one constitutes a crate root by itself; guessing wrong will instead lead module resolution to another target.
 */
function cargoEntryPoints(
  repoRoot: string,
  dir: string,
  doc: Record<string, unknown>,
): string[] {
  const declared: string[] = [];

  const lib = doc["lib"] as { path?: unknown } | undefined;
  if (typeof lib?.path === "string") declared.push(lib.path);

  const bins = doc["bin"];
  if (Array.isArray(bins)) {
    for (const bin of bins) {
      const path = (bin as { path?: unknown } | null)?.path;
      if (typeof path === "string") declared.push(path);
    }
  }

  const candidates = [...declared, "src/lib.rs", "src/main.rs"];
  const seen = new Set<string>();
  return candidates.filter((p) => {
    const normalized = toPosix(p);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return existsSync(join(repoRoot, dir, normalized));
  });
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function detectPython(repoRoot: string): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const dir of findFilesNamed(repoRoot, "pyproject.toml", 4)) {
    const content = readTextSafe(join(repoRoot, dir, "pyproject.toml"));
    if (content === null) continue;
    let name: string | null = null;
    try {
      const doc = parseToml(content) as {
        project?: { name?: unknown };
        tool?: { poetry?: { name?: unknown } };
      };
      if (typeof doc.project?.name === "string") name = doc.project.name;
      else if (typeof doc.tool?.poetry?.name === "string") name = doc.tool.poetry.name;
    } catch {
      continue;
    }
    if (name === null) continue;
    out.push({
      name,
      dir,
      manager: "python",
      entryPoints: ["src/__init__.py", "__init__.py", "main.py", "__main__.py"].filter((p) =>
        existsSync(join(repoRoot, dir, p)),
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | null {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Expand the workspace glob (such as `packages/*`) into a list of actually existing directories */
function expandGlobs(repoRoot: string, globs: string[]): string[] {
  const positive = globs.filter((g) => !g.startsWith("!"));
  const negative = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  if (positive.length === 0) return [];

  const isMatch = picomatch(positive, { dot: false });
  const isExcluded = negative.length > 0 ? picomatch(negative, { dot: false }) : () => false;

  // The deepest part in the glob determines how many levels to traverse, to avoid traversing the entire repository for `packages/*`
  const maxDepth = Math.max(
    ...positive.map((g) => (g.includes("**") ? 5 : g.split("/").length)),
  );

  const out: string[] = [];
  const visit = (absDir: string, relDir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (HARD_IGNORED_DIRS.has(entry) || entry.startsWith(".")) continue;
      const abs = join(absDir, entry);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const rel = relDir === "" ? entry : `${relDir}/${entry}`;
      if (isMatch(rel) && !isExcluded(rel)) out.push(rel);
      visit(abs, rel, depth + 1);
    }
  };
  visit(repoRoot, "", 1);
  return out;
}

/** Shallow search for the directory of the specified file name (repository-relative POSIX path, root is `.`) */
function findFilesNamed(repoRoot: string, filename: string, maxDepth: number): string[] {
  const out: string[] = [];
  const visit = (absDir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true }).map((e) =>
        e.isDirectory() ? `d:${e.name}` : `f:${e.name}`,
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.slice(2);
      if (entry.startsWith("f:")) {
        if (name === filename) {
          const rel = toPosix(relative(repoRoot, absDir));
          out.push(rel === "" ? "." : rel);
        }
        continue;
      }
      if (HARD_IGNORED_DIRS.has(name) || name.startsWith(".")) continue;
      visit(join(absDir, name), depth + 1);
    }
  };
  visit(repoRoot, 0);
  return out;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function joinPosix(a: string, b: string): string {
  if (a === "." || a === "") return b;
  return `${a}/${b}`;
}
