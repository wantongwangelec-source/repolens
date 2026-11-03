import type { DiscoveredPackage, ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { joinPosix } from "./path-utils.js";

/**
 * Go module parser.
 *
 * The biggest difference from other languages: Go's import is **package-level**, meaning the specifier corresponds to a directory rather than a file.
 * So internal hits return `internal-dir`. Which file in the directory defines the referenced symbol has to wait until link
 * The phase takes the symbol table and looks in all files in the directory.
 */
export function createGoResolver(): ModuleResolver {
  return {
    languages: ["go"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      const path = specifier.trim();
      if (path.length === 0) {
        return { status: "unresolved", reason: "空说明符" };
      }

      // Go does not support relative imports (the legacy syntax from the GOPATH era is invalid in module mode)
      if (path.startsWith(".") || path.startsWith("/")) {
        return { status: "unresolved", reason: `Go module 模式不支持相对/绝对路径 import：${path}` };
      }

      const owner = matchModule(path, ctx.packages);
      if (owner) {
        const subpath = path.slice(owner.name.length).replace(/^\//, "");
        const dir = joinPosix(owner.dir, subpath);
        if (ctx.hasDir(dir)) return { status: "internal-dir", target: dir };
        return {
          status: "unresolved",
          reason: `属于本仓库 module ${owner.name}，但包目录 ${dir} 不存在`,
        };
      }

      const first = path.split("/")[0] ?? path;
      // The first section of the standard library never contains a dot, while third-party libraries must be in the form of a domain name; this is Go's official distinction rule.
      if (!first.includes(".")) {
        return { status: "external", name: path };
      }

      return { status: "external", name: moduleNameOf(path) };
    },
  };
}

/** When prefixes are the same, take the module with the longest name to avoid `example.com/a` from taking over the resolution of `example.com/a/b` */
function matchModule(
  path: string,
  packages: readonly DiscoveredPackage[],
): DiscoveredPackage | null {
  let best: DiscoveredPackage | null = null;
  for (const pkg of packages) {
    if (pkg.manager !== "go") continue;
    if (path !== pkg.name && !path.startsWith(`${pkg.name}/`)) continue;
    if (!best || pkg.name.length > best.name.length) best = pkg;
  }
  return best;
}

/** `github.com/x/y/pkg/sub` → `github.com/x/y`: The first three segments are the identifier of the dependent repository */
function moduleNameOf(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, 3).join("/");
}
