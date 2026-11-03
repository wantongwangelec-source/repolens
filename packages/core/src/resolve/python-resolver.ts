import type { ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { dirOf, joinPosix } from "./path-utils.js";

/** Candidate extensions for module files, the order corresponds to priority */
const MODULE_EXTENSIONS = [".py", ".pyi"] as const;

/**
 * Common top-level modules of the standard library.
 *
 * No need to be exhaustive: this list is only used to directly classify imports that are 'definitely not in the warehouse' as external,
 * Names that are missed will go to the fallback branch at the back, and at worst, they will just be treated as third-party dependencies, which are also external.
 */
const STDLIB_MODULES: ReadonlySet<string> = new Set([
  "__future__", "abc", "argparse", "array", "ast", "asyncio", "base64", "bisect", "builtins",
  "bz2", "calendar", "cmath", "collections", "concurrent", "configparser", "contextlib", "copy",
  "csv", "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis", "email", "enum",
  "errno", "faulthandler", "filecmp", "fnmatch", "fractions", "ftplib", "functools", "gc",
  "getpass", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib", "importlib",
  "inspect", "io", "ipaddress", "itertools", "json", "keyword", "linecache", "locale", "logging",
  "lzma", "mailbox", "marshal", "math", "mimetypes", "mmap", "multiprocessing", "numbers",
  "operator", "os", "pathlib", "pickle", "pkgutil", "platform", "plistlib", "pprint", "queue",
  "random", "re", "readline", "reprlib", "resource", "runpy", "sched", "secrets", "select",
  "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtplib", "socket",
  "socketserver", "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess",
  "sys", "sysconfig", "tarfile", "tempfile", "termios", "textwrap", "threading", "time",
  "timeit", "token", "tokenize", "traceback", "tracemalloc", "types", "typing",
  "typing_extensions", "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings",
  "weakref", "webbrowser", "xml", "zipfile", "zlib", "zoneinfo",
]);

/**
 * Python module parser.
 *
 * The failure semantics of relative imports and absolute imports are different; this is the core trade-off of this parser:
 * The target of a relative import **must** be in the repository; if it can't be found, it is unresolved and must be exposed to the user.
 * Absolute imports are most likely from third parties, and when they can't be found, only those that 'look like they are internal packages' will report as unresolved.
 * Otherwise, everything will be external — otherwise the entire requirements.txt will fail to parse.
 */
export function createPythonResolver(): ModuleResolver {
  return {
    languages: ["python"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      if (specifier.length === 0) {
        return { status: "unresolved", reason: "空说明符" };
      }

      if (specifier.startsWith(".")) {
        return resolveRelative(specifier, ctx);
      }

      const segments = specifier.split(".").filter((s) => s.length > 0);
      const top = segments[0];
      if (top === undefined) {
        return { status: "unresolved", reason: `无法解析的模块路径：${specifier}` };
      }

      const roots = sourceRoots(ctx);
      for (const root of roots) {
        const hit = tryModule(joinPosix(root, segments.join("/")), ctx);
        if (hit) return { status: "internal", target: hit };
      }

      if (STDLIB_MODULES.has(top)) {
        return { status: "external", name: top };
      }

      // The top-level name has a package directory/declaration with the same name in the repository, indicating it should have been successfully parsed and should report an error instead of being swallowed.
      if (looksInternal(top, roots, ctx)) {
        return { status: "unresolved", reason: `仓库内存在包 ${top}，但 ${specifier} 没有对应模块文件` };
      }

      return { status: "external", name: top };
    },
  };
}

// ---------------------------------------------------------------------------
// Relative import
// ---------------------------------------------------------------------------

/**
 * `from .x import y` / `from ..x import y` / `from . import x`
 *
 * A dot = the package directory of the current file (`__init__.py` and regular modules are the same in this regard:
 * The "current package" for both is the directory they are in themselves), and each extra dot moves up one more level.
 */
function resolveRelative(specifier: string, ctx: ResolveContext): ResolveOutcome {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const rest = specifier.slice(dots);

  const base = upLevels(dirOf(ctx.fromFile), dots - 1);
  if (base === null) {
    return { status: "unresolved", reason: `相对导入 ${specifier} 越过了仓库根目录` };
  }

  if (rest.length === 0) {
    const initFile = joinPosix(base, "__init__.py");
    if (ctx.hasFile(initFile)) return { status: "internal", target: initFile };
    return { status: "unresolved", reason: `包目录 ${base} 缺少 __init__.py` };
  }

  const hit = tryModule(joinPosix(base, rest.split(".").join("/")), ctx);
  if (hit) return { status: "internal", target: hit };

  return { status: "unresolved", reason: `相对导入 ${specifier} 在 ${base} 下无匹配模块` };
}

/** Go up n levels from dir; return null if crossing the root of the repository */
function upLevels(dir: string, levels: number): string | null {
  let current = dir;
  for (let i = 0; i < levels; i++) {
    if (current === ".") return null;
    current = dirOf(current);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Candidate path
// ---------------------------------------------------------------------------

/** `a/b/c` → `a/b/c.py` / `a/b/c/__init__.py` / `a/b/c.pyi` */
function tryModule(base: string, ctx: ResolveContext): string | null {
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (ctx.hasFile(candidate)) return candidate;
    const packageInit = joinPosix(base, `__init__${ext}`);
    if (ctx.hasFile(packageInit)) return packageInit;
  }
  return null;
}

/**
 * The absolute import search root.
 *
 * Python does not have a configuration file that can reliably tell us sys.path, it can only enumerate according to community conventions:
 * The repository root, the `src/` layout, and the package directories declared by each pyproject along with their `src/`.
 */
function sourceRoots(ctx: ResolveContext): string[] {
  const roots: string[] = ["."];
  const add = (dir: string): void => {
    if (dir !== "." && !roots.includes(dir) && ctx.hasDir(dir)) roots.push(dir);
  };

  add("src");
  for (const pkg of ctx.packages) {
    if (pkg.manager !== "python") continue;
    add(pkg.dir);
    add(joinPosix(pkg.dir, "src"));
  }
  return roots;
}

function looksInternal(top: string, roots: readonly string[], ctx: ResolveContext): boolean {
  for (const root of roots) {
    if (ctx.hasDir(joinPosix(root, top))) return true;
  }
  return ctx.packages.some((p) => p.manager === "python" && normalizeDistName(p.name) === top);
}

/** PyPI distribution names use `-`, import names use `_` */
function normalizeDistName(name: string): string {
  return name.replace(/-/g, "_");
}
