import { describe, expect, it } from "vitest";
import type { DiscoveredPackage, PackageManager, ResolveContext } from "../types.js";
import { ancestorDirs } from "./path-utils.js";
import { createGoResolver } from "./go-resolver.js";
import { createPythonResolver } from "./python-resolver.js";
import { createRustResolver } from "./rust-resolver.js";
import { createTsResolver } from "./ts-resolver.js";

function pkg(name: string, dir: string, manager: PackageManager): DiscoveredPackage {
  return { name, dir, manager, entryPoints: [] };
}

/** Pseudo ResolveContext: The file set determines hasFile, and the directory set is inferred from the ancestors of the file paths */
function context(
  fromFile: string,
  files: readonly string[],
  packages: readonly DiscoveredPackage[] = [],
): ResolveContext {
  const fileSet = new Set(files);
  const dirSet = new Set<string>(["."]);
  for (const file of files) {
    for (const dir of ancestorDirs(file)) dirSet.add(dir);
  }
  return {
    root: "/repo",
    fromFile,
    hasFile: (path) => fileSet.has(path),
    hasDir: (path) => dirSet.has(path),
    packages,
  };
}

describe("createTsResolver", () => {
  const resolver = createTsResolver();
  const files = ["src/main.ts", "src/App.vue", "src/Widget.svelte", "src/Page.astro"];
  const ctx = context("src/main.ts", files);

  it.each([
    ["./App.vue", "src/App.vue"],
    ["./Widget", "src/Widget.svelte"],
    ["./Page", "src/Page.astro"],
  ])("解析复合组件 import %s", (specifier, target) => {
    expect(resolver.resolve(specifier, ctx)).toEqual({ status: "internal", target });
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_FILES = [
  "pyproject.toml",
  "src/app/__init__.py",
  "src/app/models.py",
  "src/app/services/__init__.py",
  "src/app/services/user.py",
  "src/util/__init__.py",
  "src/util/text.pyi",
];

const PY_PACKAGES = [pkg("app", ".", "python")];

describe("createPythonResolver", () => {
  const resolver = createPythonResolver();
  const from = (file: string) => context(file, PY_FILES, PY_PACKAGES);

  it("相对导入按点数回溯包层级", () => {
    const ctx = from("src/app/services/user.py");

    expect(resolver.resolve(".", ctx)).toEqual({
      status: "internal",
      target: "src/app/services/__init__.py",
    });
    expect(resolver.resolve("..", ctx)).toEqual({ status: "internal", target: "src/app/__init__.py" });
    expect(resolver.resolve("..models", ctx)).toEqual({ status: "internal", target: "src/app/models.py" });
    // The implementation file for `..util.text` is .pyi, and the candidate extensions should cover it.
    expect(resolver.resolve("...util.text", ctx)).toEqual({
      status: "internal",
      target: "src/util/text.pyi",
    });
  });

  it("同级模块与包目录都能命中", () => {
    const ctx = from("src/app/services/__init__.py");
    expect(resolver.resolve(".user", ctx)).toEqual({
      status: "internal",
      target: "src/app/services/user.py",
    });
    // `.` falls to the package's own __init__.py
    expect(resolver.resolve(".", ctx)).toEqual({
      status: "internal",
      target: "src/app/services/__init__.py",
    });
  });

  it("绝对导入按 source roots 依次尝试", () => {
    const ctx = from("src/app/services/user.py");
    expect(resolver.resolve("app.models", ctx)).toEqual({
      status: "internal",
      target: "src/app/models.py",
    });
    expect(resolver.resolve("app.services", ctx)).toEqual({
      status: "internal",
      target: "src/app/services/__init__.py",
    });
  });

  it("标准库与第三方都归为 external，name 取顶层模块名", () => {
    const ctx = from("src/app/services/user.py");
    expect(resolver.resolve("os", ctx)).toEqual({ status: "external", name: "os" });
    expect(resolver.resolve("os.path", ctx)).toEqual({ status: "external", name: "os" });
    expect(resolver.resolve("typing", ctx)).toEqual({ status: "external", name: "typing" });
    expect(resolver.resolve("__future__", ctx)).toEqual({ status: "external", name: "__future__" });
    expect(resolver.resolve("requests.adapters", ctx)).toEqual({ status: "external", name: "requests" });
  });

  it("看起来在仓库内却找不到文件时报 unresolved", () => {
    const ctx = from("src/app/services/user.py");

    // The target of a relative import must be in the repository; not finding it is a real failure.
    const relative = resolver.resolve(".missing", ctx);
    expect(relative.status).toBe("unresolved");
    expect(relative).toHaveProperty("reason", expect.stringContaining(".missing"));

    // The top-level name has a directory with the same name as the package, indicating that it should have been parsed successfully.
    const absolute = resolver.resolve("app.missing", ctx);
    expect(absolute.status).toBe("unresolved");
    expect(absolute).toHaveProperty("reason", expect.stringContaining("app"));

    expect(resolver.resolve(".....x", ctx)).toMatchObject({
      status: "unresolved",
      reason: expect.stringContaining("仓库根"),
    });
    expect(resolver.resolve("", ctx)).toEqual({ status: "unresolved", reason: "空说明符" });
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

describe("createGoResolver", () => {
  const resolver = createGoResolver();
  const GO_FILES = [
    "go.mod",
    "main.go",
    "internal/db/db.go",
    "internal/store/store.go",
    "tools/go.mod",
    "tools/cli/main.go",
  ];
  const GO_PACKAGES = [
    pkg("example.com/app", ".", "go"),
    pkg("example.com/app/tools", "tools", "go"),
  ];
  const ctx = context("internal/store/store.go", GO_FILES, GO_PACKAGES);

  it("本仓库 module 前缀映射到包目录，返回 internal-dir", () => {
    expect(resolver.resolve("example.com/app/internal/db", ctx)).toEqual({
      status: "internal-dir",
      target: "internal/db",
    });
    // A module itself is also a package
    expect(resolver.resolve("example.com/app", ctx)).toEqual({ status: "internal-dir", target: "." });
  });

  it("同前缀时取 module 名最长的那个", () => {
    expect(resolver.resolve("example.com/app/tools/cli", ctx)).toEqual({
      status: "internal-dir",
      target: "tools/cli",
    });
  });

  it("第一段不含点号的是标准库", () => {
    expect(resolver.resolve("fmt", ctx)).toEqual({ status: "external", name: "fmt" });
    expect(resolver.resolve("net/http", ctx)).toEqual({ status: "external", name: "net/http" });
  });

  it("含域名的第三方依赖只取前三段作为 name", () => {
    expect(resolver.resolve("github.com/google/uuid", ctx)).toEqual({
      status: "external",
      name: "github.com/google/uuid",
    });
    expect(resolver.resolve("github.com/google/uuid/v5/internal", ctx)).toEqual({
      status: "external",
      name: "github.com/google/uuid",
    });
  });

  it("属于本 module 但目录不存在时报 unresolved", () => {
    expect(resolver.resolve("example.com/app/internal/missing", ctx)).toMatchObject({
      status: "unresolved",
      reason: expect.stringContaining("internal/missing"),
    });
    expect(resolver.resolve("./relative", ctx)).toMatchObject({ status: "unresolved" });
    expect(resolver.resolve("", ctx)).toEqual({ status: "unresolved", reason: "空说明符" });
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RS_FILES = [
  "crates/store/Cargo.toml",
  "crates/store/src/lib.rs",
  "crates/store/src/config.rs",
  "crates/store/src/cache.rs",
  "crates/store/src/handlers.rs",
  "crates/store/src/handlers/http.rs",
  "crates/store/src/handlers/errors.rs",
  "crates/store/src/store/mod.rs",
  "crates/store/src/store/models.rs",
  "crates/cli/Cargo.toml",
  "crates/cli/src/main.rs",
  "crates/cli/src/args.rs",
];

const RS_PACKAGES = [
  pkg("repolens-store", "crates/store", "cargo"),
  pkg("repolens-cli", "crates/cli", "cargo"),
];

describe("createRustResolver", () => {
  const resolver = createRustResolver();
  const from = (file: string) => context(file, RS_FILES, RS_PACKAGES);

  it("crate:: 从所属 crate 的 src 出发，认 foo.rs 与 foo/mod.rs 两种布局", () => {
    const ctx = from("crates/store/src/handlers/http.rs");
    expect(resolver.resolve("crate::config", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/config.rs",
    });
    expect(resolver.resolve("crate::store", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/store/mod.rs",
    });
    expect(resolver.resolve("crate::store::models", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/store/models.rs",
    });
  });

  it("最后一段是符号名时回退到上一级模块文件", () => {
    const ctx = from("crates/store/src/handlers/http.rs");
    // `Record` is a symbol in store/mod.rs, not in store/Record.rs
    expect(resolver.resolve("crate::store::Record", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/store/mod.rs",
    });
    // The only possibility when only one segment is left is the crate root.
    expect(resolver.resolve("crate::MAX_ENTRIES", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/lib.rs",
    });
  });

  it("super:: 逐层剥当前模块路径，self:: 从当前模块出发", () => {
    const ctx = from("crates/store/src/handlers/http.rs");
    expect(resolver.resolve("super::errors", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/handlers/errors.rs",
    });
    // `super::Foo` can only be defined in the parent module's own file
    expect(resolver.resolve("super::Helper", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/handlers.rs",
    });
    expect(resolver.resolve("super::super::config", ctx)).toEqual({
      status: "internal",
      target: "crates/store/src/config.rs",
    });

    const root = from("crates/store/src/lib.rs");
    expect(resolver.resolve("self::cache", root)).toEqual({
      status: "internal",
      target: "crates/store/src/cache.rs",
    });
    // When the middle section is inline mod, the symbol can only be in the current file
    expect(resolver.resolve("self::inner::Thing", root)).toEqual({
      status: "internal",
      target: "crates/store/src/lib.rs",
    });
  });

  it("workspace 内的其他 crate 按 `-`→`_` 归一化后解析", () => {
    const ctx = from("crates/store/src/lib.rs");
    expect(resolver.resolve("repolens_cli::args", ctx)).toEqual({
      status: "internal",
      target: "crates/cli/src/args.rs",
    });
    // When a cross-crate import only specifies the crate name, it falls to its entry file.
    expect(resolver.resolve("repolens_cli", ctx)).toEqual({
      status: "internal",
      target: "crates/cli/src/main.rs",
    });
  });

  it("std 与第三方 crate 归为 external，name 取第一段", () => {
    const ctx = from("crates/store/src/lib.rs");
    expect(resolver.resolve("std::collections", ctx)).toEqual({ status: "external", name: "std" });
    expect(resolver.resolve("core", ctx)).toEqual({ status: "external", name: "core" });
    expect(resolver.resolve("serde::de", ctx)).toEqual({ status: "external", name: "serde" });
    expect(resolver.resolve("tokio", ctx)).toEqual({ status: "external", name: "tokio" });
  });

  it("路径不存在时报 unresolved，不退到 crate 根乱猜", () => {
    const ctx = from("crates/store/src/handlers/http.rs");

    expect(resolver.resolve("crate::nonexistent::deep", ctx)).toMatchObject({
      status: "unresolved",
      reason: expect.stringContaining("crates/store/src"),
    });
    // `mod foo;` Form: The target must be foo.rs; it cannot fallback to the current file
    expect(resolver.resolve("self::missing_mod", from("crates/store/src/lib.rs"))).toMatchObject({
      status: "unresolved",
    });
    expect(resolver.resolve("super::super::super::x", ctx)).toMatchObject({
      status: "unresolved",
      reason: expect.stringContaining("super"),
    });
    expect(resolver.resolve("", ctx)).toEqual({ status: "unresolved", reason: "空说明符" });
  });
});
