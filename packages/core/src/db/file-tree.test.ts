import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { openDb, type Db } from "./database.js";
import { getFileTree, readRepoFile } from "./file-tree.js";

const roots: string[] = [];
// Creating a symbolic link on Windows requires administrator privileges or developer mode
const symlinks = process.platform !== "win32";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("getFileTree", () => {
  it("按磁盘列全部条目：源码在前，噪音和没进索引的在后，并给出排除原因", () => {
    const { root, db } = fixture();
    try {
      const config = { ...DEFAULT_CONFIG, maxFileBytes: 64 };
      const status = (path: string) =>
        Object.fromEntries((getFileTree(db, root, config, path).children ?? []).map((node) => [
          node.name, node.status === "excluded" ? `excluded:${node.excludedBy}` : node.status,
        ]));

      expect(status(".")).toEqual({
        src: "analyzed",
        docs: "noise",
        vendor: "noise",
        "README.md": "noise",
        dist: "excluded:ignored",
        node_modules: "excluded:builtin",
        ".gitignore": "excluded:unscanned",
        "big.txt": "excluded:too-large",
        "logo.png": "excluded:unscanned",
        ...(symlinks ? { link: "excluded:symlink", escape: "excluded:symlink" } : {}),
      });
      expect(getFileTree(db, root, config).children?.map((node) => node.name).slice(0, 4))
        .toEqual(["src", "docs", "vendor", "README.md"]);
      expect(status("src")).toEqual({ "a.ts": "analyzed", "a.test.ts": "noise", "new.ts": "excluded:unscanned" });
      expect(status("dist")).toEqual({ "out.js": "excluded:ignored" });
      expect(status("node_modules/pkg")).toEqual({ "index.js": "excluded:builtin" });
      expect(status("vendor")).toEqual({ "lib.js": "excluded:vendor" });
      expect(() => getFileTree(db, root, config, "../")).toThrow("非法的路径");
      expect(() => getFileTree(db, root, config, ".git")).toThrow("非法的路径");
    } finally {
      db.close();
    }
  });
});

describe("readRepoFile", () => {
  it("读没进索引的文件原文，拒绝越界、版本库元数据、软链接和二进制", () => {
    const { root, db } = fixture();
    db.close();
    expect(readRepoFile(root, "dist/out.js")).toMatchObject({
      path: "dist/out.js", language: "javascript", startLine: 1, code: "console.log(1);\n",
    });
    const status = (path: string) => {
      try {
        readRepoFile(root, path);
        return 200;
      } catch (err) {
        return (err as { status: number }).status;
      }
    };
    expect(status("../outside.txt")).toBe(400);
    expect(status(".git/config")).toBe(400);
    expect(status("missing.ts")).toBe(404);
    expect(status("src")).toBe(400);
    expect(status("logo.png")).toBe(415);
    if (symlinks) {
      expect(status("link")).toBe(415);
      expect(status("escape/secret.txt")).toBe(404);
    }
  });
});

function fixture(): { root: string; db: Db } {
  const base = mkdtempSync(join(tmpdir(), "repolens-file-tree-"));
  roots.push(base);
  const root = join(base, "repo");
  const files: Record<string, string | Buffer> = {
    ".gitignore": "dist/\n",
    ".git/config": "[core]\n",
    "README.md": "# demo\n",
    "src/a.ts": "export const a = 1;\n",
    "src/a.test.ts": "test\n",
    "src/new.ts": "export {};\n",
    "docs/guide.md": "guide\n",
    "dist/out.js": "console.log(1);\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
    "vendor/lib.js": "var x;\n",
    "big.txt": "x".repeat(100),
    "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "outside/secret.txt"), "secret\n");
  if (symlinks) {
    symlinkSync(join(root, "src"), join(root, "link"));
    symlinkSync(join(base, "outside"), join(root, "escape"));
  }

  const db = openDb(join(base, "index.db"));
  for (const dir of ["src", "docs", "vendor"]) {
    db.prepare("INSERT INTO directories (path, parent_path, name, depth) VALUES (?, NULL, ?, 1)").run(dir, dir);
  }
  const insert = db.prepare(
    `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash, parsed, complexity)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1, 1)`,
  );
  insert.run("src/a.ts", "src", "a.ts", "typescript", "source", "h1");
  insert.run("src/a.test.ts", "src", "a.test.ts", "typescript", "test", "h2");
  insert.run("README.md", ".", "README.md", "markdown", "docs", "h3");
  insert.run("docs/guide.md", "docs", "guide.md", "markdown", "docs", "h4");
  return { root, db };
}
