import type { DiscoveredPackage, ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { dirOf, isWithin, joinPosix, stripExtension } from "./path-utils.js";

/** Language comes with a crate by default and is never in the repository */
const BUILTIN_CRATES: ReadonlySet<string> = new Set(["std", "core", "alloc", "proc_macro", "test"]);

/** When the file is named like these, the file represents the module at the directory (or crate root) level, rather than a submodule with the same name. */
const MODULE_ROOT_STEMS: ReadonlySet<string> = new Set(["mod", "lib", "main"]);

/**
 * Rust module parser.
 *
 * Core difficulty: The last segment of the specifier may be a module name or a symbol name — `b` in `crate::a::b`
 * It could be a struct in `a/b.rs` or in `a.rs`. The contract of ModuleResolver only provides
 * Specifier, cannot get the list of specifiers, so here the path prefix is progressively backed off, hitting the first real file
 * That's the answer. The rollback only goes back until there's one section left; it won't roll all the way back to `lib.rs`, otherwise any misspelled path would be
 * Incorrectly parsed as the crate root.
 *
 * Use fallback only when 'the symbol has nowhere else to go': `super::Foo` must be defined in the parent module
 * In your own file, `crate::Foo` must be at the root of the crate. This is not a guess; it is the only possible conclusion.
 */
export function createRustResolver(): ModuleResolver {
  return {
    languages: ["rust"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      const segments = splitPath(specifier);
      const head = segments[0];
      if (head === undefined) {
        return { status: "unresolved", reason: "空说明符" };
      }

      const srcDir = crateRootOf(ctx);
      const ownModule = moduleSegments(ctx.fromFile, srcDir);

      if (head === "crate" || head === "$crate") {
        const tail = segments.slice(1);
        return resolveWithin(tail, srcDir, ctx, specifier, tail.length <= 1 ? [] : undefined);
      }

      if (head === "self") {
        const tail = segments.slice(1);
        // When the length is 1, it takes the form `mod foo;`, and the target should be foo.rs instead of the current file.
        // If it can't be found, it should be reported; length >= 2 indicates that the middle part is an inline mod, which can only be in the current file
        const fallback = tail.length === 1 ? undefined : ownModule;
        return resolveWithin([...ownModule, ...tail], srcDir, ctx, specifier, fallback);
      }

      if (head === "super") {
        let depth = 0;
        while (segments[depth] === "super") depth++;
        if (depth > ownModule.length) {
          return { status: "unresolved", reason: `${specifier} 的 super 层数超出当前模块深度` };
        }
        const base = ownModule.slice(0, ownModule.length - depth);
        const tail = segments.slice(depth);
        return resolveWithin([...base, ...tail], srcDir, ctx, specifier, tail.length <= 1 ? base : undefined);
      }

      const crate = matchCrate(head, ctx.packages);
      if (crate) {
        // Referencing the other party's lib.rs across crates is a reasonable answer: that is its only public entry point
        return resolveWithin(segments.slice(1), crateRootFor(crate), ctx, specifier, []);
      }

      if (BUILTIN_CRATES.has(head)) {
        return { status: "external", name: head };
      }

      // Uniform paths in Rust 2018: top-level modules under the crate root can omit the `crate::` prefix.
      // No fallback is given here; only exact matches are recognized, otherwise third-party crates may be mistakenly identified as internal modules.
      const uniform = findModuleFile(segments, srcDir, ctx);
      if (uniform) return { status: "internal", target: uniform };

      return { status: "external", name: head };
    },
  };
}

// ---------------------------------------------------------------------------
// Module Path → File
// ---------------------------------------------------------------------------

function resolveWithin(
  segments: readonly string[],
  srcDir: string,
  ctx: ResolveContext,
  specifier: string,
  fallbackModule: readonly string[] | undefined,
): ResolveOutcome {
  const direct = findModuleFile(segments, srcDir, ctx);
  if (direct) return { status: "internal", target: direct };

  if (fallbackModule) {
    const hit = moduleFile(fallbackModule, srcDir, ctx);
    if (hit) return { status: "internal", target: hit };
  }

  return { status: "unresolved", reason: `${specifier} 在 ${srcDir} 下没有对应的 .rs / mod.rs` };
}

/** Gradually backtrack from the longest prefix, the first existing file is the target. */
function findModuleFile(
  segments: readonly string[],
  srcDir: string,
  ctx: ResolveContext,
): string | null {
  for (let length = segments.length; length >= 1; length--) {
    const hit = moduleFile(segments.slice(0, length), srcDir, ctx);
    if (hit) return hit;
  }
  return null;
}

/** The concrete file corresponding to the module path: `a/b` → `a/b.rs` or `a/b/mod.rs`; empty path → crate root */
function moduleFile(
  segments: readonly string[],
  srcDir: string,
  ctx: ResolveContext,
): string | null {
  if (segments.length === 0) {
    for (const stem of ["lib.rs", "main.rs"]) {
      const candidate = joinPosix(srcDir, stem);
      if (ctx.hasFile(candidate)) return candidate;
    }
    return null;
  }

  const prefix = segments.join("/");
  const asFile = joinPosix(srcDir, `${prefix}.rs`);
  if (ctx.hasFile(asFile)) return asFile;
  const asDirectory = joinPosix(srcDir, prefix, "mod.rs");
  if (ctx.hasFile(asDirectory)) return asDirectory;
  return null;
}

/**
 * The current file's module path within its own crate.
 *
 * `src/lib.rs` → `[]`，`src/store/mod.rs` → `["store"]`，
 * `src/store/models.rs` → `["store","models"]`。
 */
function moduleSegments(file: string, srcDir: string): string[] {
  if (!isWithin(srcDir, file)) return [];
  const relative = srcDir === "." ? file : file.slice(srcDir.length + 1);
  const parts = stripExtension(relative)
    .split("/")
    .filter((p) => p.length > 0);
  if (MODULE_ROOT_STEMS.has(parts.at(-1) ?? "")) parts.pop();
  return parts;
}

function splitPath(specifier: string): string[] {
  return specifier
    .split("::")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// crate positioning
// ---------------------------------------------------------------------------

/** Cargo automatically discovers the target's directories, and each .rs file in the directory is the root of its own crate. */
const AUTO_TARGET_DIRS = ["tests", "benches", "examples", "src/bin"] as const;

/**
 * The root directory of the crate to which the current file belongs.
 *
 * Cannot directly recognize `<package directory>/src`: Cargo allows `[lib]` / `[[bin]]` to use `path` for the entry
 * Point to any location, and the directory at that location is the crate root of that target. So from the declaration
 * Backtrack candidate roots from the entry point and take **the longest one that contains the current file** — which target a file belongs to,
 * It should be resolved according to the root of that target for `crate::`.
 *
 * When there is no Cargo.toml, return the first `src` segment in the path.
 */
function crateRootOf(ctx: ResolveContext): string {
  let best: DiscoveredPackage | null = null;
  for (const pkg of ctx.packages) {
    if (pkg.manager !== "cargo") continue;
    if (!isWithin(pkg.dir, ctx.fromFile)) continue;
    if (!best || pkg.dir.length > best.dir.length) best = pkg;
  }

  if (best) {
    let root: string | null = null;

    // Cargo automatically discovers the target directories: in each of these directories, every .rs file is a crate root.
    // So the directory itself is the starting point for resolving `crate::`. This is a fixed convention, not a guess.
    // And ripgrep's tests/tests.rs relies on `mod util;` to import tests/util.rs, which is exactly this form.
    for (const convention of AUTO_TARGET_DIRS) {
      const dir = joinPosix(best.dir, convention);
      if (isWithin(dir, ctx.fromFile) && (root === null || dir.length > root.length)) root = dir;
    }

    for (const entry of best.entryPoints ?? []) {
      const dir = dirOf(joinPosix(best.dir, entry));
      if (!isWithin(dir, ctx.fromFile)) continue;
      if (root === null || dir.length > root.length) root = dir;
    }
    return root ?? joinPosix(best.dir, "src");
  }

  const parts = ctx.fromFile.split("/");
  const index = parts.indexOf("src");
  if (index >= 0) return parts.slice(0, index + 1).join("/");
  return dirOf(ctx.fromFile);
}

/** When referencing the root directory of another crate; the other party's files are not on hand, so they can only be accessed according to the entry declaration */
function crateRootFor(pkg: DiscoveredPackage): string {
  const entry = (pkg.entryPoints ?? []).find((p) => p.endsWith("lib.rs")) ?? pkg.entryPoints?.[0];
  return entry !== undefined ? dirOf(joinPosix(pkg.dir, entry)) : joinPosix(pkg.dir, "src");
}

/** Cargo package names use `-`, Rust paths use `_`, they must be normalized before comparing */
function matchCrate(head: string, packages: readonly DiscoveredPackage[]): DiscoveredPackage | null {
  for (const pkg of packages) {
    if (pkg.manager !== "cargo") continue;
    if (pkg.name.replace(/-/g, "_") === head) return pkg;
  }
  return null;
}
