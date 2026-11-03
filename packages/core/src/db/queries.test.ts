import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./database.js";
import { getOverview, getRevealChain, getScopeGraph, getScopeReadme, getTree } from "./queries.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("目录角色过滤", () => {
  it("默认隐藏只含配置文件的目录，显示噪音时恢复", () => {
    const db = fixtureDb();
    try {
      expect(getScopeGraph(db, { scope: "dir:.", roles: ["source"] }).nodes.map((n) => n.id))
        .toEqual(["dir:src"]);
      expect(getTree(db, ".", 1, ["source"]).children?.map((n) => n.id))
        .toEqual(["dir:src"]);

      const roles = ["source", "config"] as const;
      expect(getScopeGraph(db, { scope: "dir:.", roles: [...roles] }).nodes.map((n) => n.id).sort())
        .toEqual(["dir:.cursor", "dir:src"]);
      expect(getTree(db, ".", 1, [...roles]).children?.map((n) => n.id).sort())
        .toEqual(["dir:.cursor", "dir:src"]);
    } finally {
      db.close();
    }
  });

  it("零散子目录包未覆盖主体源码时退化为顶层目录视图，不抹掉未归属的 packages 目录", () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-partial-pkg-"));
    roots.push(root);
    const db = openDb(join(root, "index.db"));
    try {
      for (const [path, parent, name, depth] of [
        ["hack", null, "hack", 1],
        ["hack/sub", "hack", "sub", 2],
        ["packages", null, "packages", 1],
        ["packages/tool", "packages", "tool", 2],
        ["workshops", null, "workshops", 1],
        ["workshops/py", "workshops", "py", 2],
        ["workshops/ts", "workshops", "ts", 2],
      ] as const) {
        db.prepare("INSERT INTO directories (path, parent_path, name, depth) VALUES (?, ?, ?, ?)").run(path, parent, name, depth);
      }

      const p1 = Number(db.prepare("INSERT INTO packages (name, dir, manager) VALUES (?, ?, ?)").run("sub", "hack/sub", "python").lastInsertRowid);
      const p2 = Number(db.prepare("INSERT INTO packages (name, dir, manager) VALUES (?, ?, ?)").run("workshops", "workshops/py", "python").lastInsertRowid);

      const insertPkgFile = (path: string, dirPath: string, pkgId: number | null, loc: number) => {
        db.prepare(
          `INSERT INTO files (path, dir_path, name, language, role, package_id, loc, bytes, hash, parsed, complexity)
           VALUES (?, ?, ?, 'typescript', 'source', ?, ?, 10, ?, 1, 1)`,
        ).run(path, dirPath, path.split("/").at(-1)!, pkgId, loc, `hash:${path}`);
      };

      insertPkgFile("hack/sub/a.py", "hack/sub", p1, 10);
      insertPkgFile("workshops/py/b.py", "workshops/py", p2, 20);
      insertPkgFile("packages/tool/c.ts", "packages/tool", null, 50);
      insertPkgFile("workshops/ts/d.ts", "workshops/ts", null, 60);
      insertPkgFile("workshops/ts/e.ts", "workshops/ts", null, 60);

      expect(getScopeGraph(db, { scope: "dir:." }).nodes.map((n) => n.id)).toEqual([
        "dir:hack",
        "dir:packages",
        "dir:workshops",
      ]);
      expect(getRevealChain(db, "dir:workshops/py")).toEqual(["dir:workshops"]);
      expect(getRevealChain(db, "dir:packages/tool")).toEqual(["dir:packages"]);
      expect(getOverview(db).packages).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("getScopeReadme", () => {
  it("取这一层自己的 README，README.md 优先，同名的代码文件不算", () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-readme-"));
    roots.push(root);
    mkdirSync(join(root, "packages/core/src"), { recursive: true });
    const files: Array<[string, string]> = [
      ["README.zh-CN.md", "# 中文说明"],
      ["README.md", "# Repo\n\nWhat it does."],
      ["readme-utils.ts", "export {};"],
      ["packages/core/README", "plain text readme"],
      ["packages/core/src/main.ts", "export {};"],
    ];
    const db = openDb(join(root, "index.db"));
    try {
      for (const [path, content] of files) {
        writeFileSync(join(root, path), content);
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
        insertFile(db, path, dir, path.split("/").at(-1)!, "markdown", "docs");
      }
      db.prepare("INSERT INTO packages (name, dir, manager) VALUES (?, ?, ?)").run("@demo/core", "packages/core", "pnpm");

      expect(getScopeReadme(db, root, "dir:.")).toMatchObject({
        path: "README.md", format: "markdown", content: "# Repo\n\nWhat it does.", truncated: false,
      });
      expect(getScopeReadme(db, root, "pkg:@demo/core")).toMatchObject({
        path: "packages/core/README", format: "text",
      });
      expect(getScopeReadme(db, root, "dir:packages/core/src")).toBeNull();
      expect(getScopeReadme(db, root, "sym:1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("超长的 README 截在整行处并标记", () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-readme-"));
    roots.push(root);
    writeFileSync(join(root, "README.md"), "一行说明文字\n".repeat(10_000));
    const db = openDb(join(root, "index.db"));
    try {
      insertFile(db, "README.md", ".", "README.md", "markdown", "docs");
      const readme = getScopeReadme(db, root, "dir:.")!;
      expect(readme.truncated).toBe(true);
      expect(readme.content.length).toBeLessThan(64 * 1024);
      expect(readme.content.split("\n").every((line) => line === "一行说明文字")).toBe(true);
    } finally {
      db.close();
    }
  });
});

function fixtureDb(): Db {
  const root = mkdtempSync(join(tmpdir(), "repolens-role-query-"));
  roots.push(root);
  const db = openDb(join(root, "index.db"));
  db.prepare(
    "INSERT INTO directories (path, parent_path, name, depth) VALUES (?, NULL, ?, 1)",
  ).run(".cursor", ".cursor");
  db.prepare(
    "INSERT INTO directories (path, parent_path, name, depth) VALUES (?, NULL, ?, 1)",
  ).run("src", "src");

  insertFile(db, ".cursor/rules/project.mdc", ".cursor", "project.mdc", "other", "config");
  insertFile(db, "src/main.ts", "src", "main.ts", "typescript", "source");
  return db;
}

function insertFile(
  db: Db,
  path: string,
  dirPath: string,
  name: string,
  language: string,
  role: string,
): void {
  db.prepare(
    `INSERT INTO files
       (path, dir_path, name, language, role, loc, bytes, hash, parsed, complexity)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1, 1)`,
  ).run(path, dirPath, name, language, role, `hash:${path}`);
}
