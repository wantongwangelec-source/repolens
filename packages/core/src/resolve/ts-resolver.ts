import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredPackage, ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { dirOf, joinPosix, normalizePosix } from "./path-utils.js";

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
  ".d.ts",
] as const;

/**
 * TypeScript / JavaScript module resolver.
 *
 * Cover four forms of specifiers, trying them in order from low to high cost:
 * 1. Relative paths `./x` `../x`
 * 2. `paths` aliases in tsconfig
 * 3. workspace package name
 * 4. The rest are regarded as third parties
 *
 * The easiest point to be overlooked is the `.js` extension convention under NodeNext: writing `./foo.js` in the source code,
 * The file on the disk is actually `foo.ts`. If we don't handle this, the parsing rate of modern TS repositories will directly drop to single digits.
 */
export function createTsResolver(): ModuleResolver {
  const tsconfigCache = new Map<string, TsPathMapping | null>();

  return {
    languages: ["typescript", "tsx", "javascript", "jsx", "vue", "svelte", "astro"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      if (specifier.length === 0) {
        return { status: "unresolved", reason: "空说明符" };
      }

      // Imports of non-source resources (CSS / images / wasm) are not considered code dependencies
      if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|ttf|wasm|json|txt|md)$/i.test(specifier)) {
        if (specifier.startsWith(".")) {
          const target = tryFile(joinPosix(dirOf(ctx.fromFile), specifier), ctx);
          if (target) return { status: "internal", target };
        }
        return { status: "external", name: specifier };
      }

      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const base = joinPosix(dirOf(ctx.fromFile), specifier);
        const target = tryFile(base, ctx);
        return target
          ? { status: "internal", target }
          : { status: "unresolved", reason: `相对路径无匹配文件：${base}` };
      }

      if (specifier.startsWith("/")) {
        return { status: "unresolved", reason: "绝对路径 import 无法在仓库内定位" };
      }

      if (specifier.startsWith("node:")) {
        return { status: "external", name: specifier };
      }

      const mapping = pathMappingFor(ctx, ctx.fromFile, tsconfigCache);
      if (mapping) {
        const viaPaths = resolveViaPaths(specifier, mapping, ctx);
        if (viaPaths) return { status: "internal", target: viaPaths };
      }

      const viaWorkspace = resolveWorkspacePackage(specifier, ctx);
      if (viaWorkspace) return viaWorkspace;

      return { status: "external", name: packageNameOf(specifier) };
    },
  };
}

// ---------------------------------------------------------------------------
// Document candidates
// ---------------------------------------------------------------------------

function tryFile(base: string, ctx: ResolveContext): string | null {
  for (const candidate of candidatePaths(base)) {
    if (ctx.hasFile(candidate)) return candidate;
  }
  return null;
}

function candidatePaths(base: string): string[] {
  const out: string[] = [base];

  // `./foo.js` → `./foo.ts`: TS's NodeNext convention
  const jsExt = /\.(js|mjs|cjs|jsx)$/.exec(base);
  if (jsExt) {
    const stem = base.slice(0, -jsExt[0].length);
    out.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}.d.ts`);
  }

  const hasKnownExt = SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext));
  if (!hasKnownExt) {
    for (const ext of SOURCE_EXTENSIONS) out.push(base + ext);
  }

  for (const ext of SOURCE_EXTENSIONS) out.push(`${base}/index${ext}`);

  return out;
}

// ---------------------------------------------------------------------------
// tsconfig paths
// ---------------------------------------------------------------------------

interface TsPathMapping {
  /** The baseUrl directory relative to the root of the repository */
  baseDir: string;
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

function pathMappingFor(
  ctx: ResolveContext,
  fromFile: string,
  cache: Map<string, TsPathMapping | null>,
): TsPathMapping | null {
  // Find the nearest tsconfig upward from the directory where the file is located, consistent with the behavior of tsc
  let dir = dirOf(fromFile);
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      if (cached !== null) return cached;
    } else {
      const configPath = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
      const loaded = ctx.hasFile(configPath) ? loadTsPathMapping(ctx.root, configPath) : null;
      cache.set(dir, loaded);
      if (loaded !== null) return loaded;
    }
    if (dir === ".") return null;
    dir = dirOf(dir);
  }
}

function loadTsPathMapping(root: string, configRelPath: string, depth = 0): TsPathMapping | null {
  if (depth > 5) return null;

  const json = readJsonc(join(root, configRelPath));
  if (!json) return null;

  const options = (json["compilerOptions"] ?? {}) as Record<string, unknown>;
  const configDir = dirOf(configRelPath);
  const baseUrl = typeof options["baseUrl"] === "string" ? options["baseUrl"] : null;
  const rawPaths = options["paths"];

  if (rawPaths && typeof rawPaths === "object") {
    const baseDir = normalizePosix(joinPosix(configDir, baseUrl ?? "."));
    const paths: TsPathMapping["paths"] = [];
    for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf("*");
      paths.push({
        prefix: star >= 0 ? pattern.slice(0, star) : pattern,
        suffix: star >= 0 ? pattern.slice(star + 1) : "",
        targets: targets.filter((t): t is string => typeof t === "string"),
      });
    }
    if (paths.length > 0) return { baseDir, paths };
  }

  // If there are no paths on this level, continue searching along the extends chain
  const extendsField = json["extends"];
  if (typeof extendsField === "string" && extendsField.startsWith(".")) {
    const parentRel = normalizePosix(joinPosix(configDir, extendsField));
    const withExt = parentRel.endsWith(".json") ? parentRel : `${parentRel}.json`;
    return loadTsPathMapping(root, withExt, depth + 1);
  }

  return null;
}

function resolveViaPaths(
  specifier: string,
  mapping: TsPathMapping,
  ctx: ResolveContext,
): string | null {
  for (const entry of mapping.paths) {
    if (!specifier.startsWith(entry.prefix)) continue;
    if (entry.suffix.length > 0 && !specifier.endsWith(entry.suffix)) continue;

    const wildcard = specifier.slice(
      entry.prefix.length,
      entry.suffix.length > 0 ? specifier.length - entry.suffix.length : undefined,
    );

    for (const target of entry.targets) {
      const substituted = target.includes("*") ? target.replace("*", wildcard) : target;
      const base = normalizePosix(joinPosix(mapping.baseDir, substituted));
      const hit = tryFile(base, ctx);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// workspace package
// ---------------------------------------------------------------------------

function resolveWorkspacePackage(specifier: string, ctx: ResolveContext): ResolveOutcome | null {
  const pkg = matchPackage(specifier, ctx.packages);
  if (!pkg) return null;

  const subpath = specifier.slice(pkg.name.length).replace(/^\//, "");

  if (subpath.length === 0) {
    // Package root: Prefer to look for the declared entry first, then fall back to the agreed location
    for (const entry of pkg.entryPoints) {
      const hit = tryFile(normalizePosix(joinPosix(pkg.dir, entry)), ctx);
      if (hit) return { status: "internal", target: hit };
    }
    for (const fallback of ["src/index", "index", "src/main", "lib/index"]) {
      const hit = tryFile(normalizePosix(joinPosix(pkg.dir, fallback)), ctx);
      if (hit) return { status: "internal", target: hit };
    }
    return { status: "unresolved", reason: `workspace 包 ${pkg.name} 未找到入口文件` };
  }

  // Subpath export: `@scope/pkg/types` may correspond to src/types.ts or to types.ts
  for (const prefix of ["src", "", "lib", "dist"]) {
    const base = normalizePosix(joinPosix(pkg.dir, joinPosix(prefix, subpath)));
    const hit = tryFile(base, ctx);
    if (hit) return { status: "internal", target: hit };
  }

  // The exports mapping may point subpaths to any location, using the one with the same name in the entry list as a fallback.
  const entryHit = pkg.entryPoints.find((e) => e.includes(subpath));
  if (entryHit) {
    const hit = tryFile(normalizePosix(joinPosix(pkg.dir, entryHit)), ctx);
    if (hit) return { status: "internal", target: hit };
  }

  return { status: "unresolved", reason: `workspace 包 ${pkg.name} 的子路径 ${subpath} 未命中` };
}

function matchPackage(
  specifier: string,
  packages: readonly DiscoveredPackage[],
): DiscoveredPackage | null {
  let best: DiscoveredPackage | null = null;
  for (const pkg of packages) {
    if (pkg.manager === "go" || pkg.manager === "cargo" || pkg.manager === "python") continue;
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    // When the prefix is the same, take the longest name to prevent `@a/b` from hijacking the parsing of `@a/b-c`
    if (!best || pkg.name.length > best.name.length) best = pkg;
  }
  return best;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/**
 * tsconfig.json almost always contains comments and trailing commas, which will cause a standard JSON.parse to throw an error.
 * Here we perform minimal fault-tolerant handling, without introducing a full JSONC parser.
 */
function readJsonc(absPath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  if (!existsSync(absPath)) return null;

  const stripped = stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1");
  try {
    const parsed = JSON.parse(stripped);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
