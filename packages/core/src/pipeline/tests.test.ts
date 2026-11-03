import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-tests-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scanFixture(files: Record<string, string>): Promise<Db> {
  const root = mkdtempSync(join(tmpdir(), "repolens-tests-"));
  roots.push(root);
  writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await scanRepo({ root, fresh: true });
  return openDb(indexPath(root), { readonly: true });
}

describe("测试即规格", () => {
  it("describe / it 的回调成为用例符号，用例走到的源码函数记下覆盖", async () => {
    const db = await scanFixture({
      "src/math.ts": `
        export function add(a: number, b: number) { return a + b; }
        export function sum(list: number[]) { return list.reduce((acc, n) => add(acc, n), 0); }
        export function untested() { return 0; }
      `,
      "src/math.test.ts": `
        import { describe, expect, it } from "vitest";
        import { add, sum } from "./math";
        function total(list: number[]) { return sum(list); }
        describe("math", () => {
          it("adds two numbers", () => { expect(add(1, 2)).toBe(3); });
          it.each([[1], [2]])("sums lists of %s", () => { expect(total([1, 2])).toBe(3); });
        });
      `,
    });
    try {
      const tests = db.prepare(
        "SELECT name, test_kind AS kind FROM symbols WHERE test_kind IS NOT NULL ORDER BY start_line",
      ).all();
      expect(tests).toEqual([
        { name: "math", kind: "suite" },
        { name: "adds two numbers", kind: "case" },
        { name: "sums lists of %s", kind: "case" },
      ]);

      const coverage = (name: string) => db.prepare(
        `SELECT t.tests, t.direct FROM test_coverage t JOIN symbols s ON s.id = t.symbol_id WHERE s.name = ?`,
      ).get(name) as { tests: number; direct: number } | undefined;
      // add: one test case calls it directly, the other goes indirectly through the test helper function and sum
      expect(coverage("add")).toEqual({ tests: 2, direct: 1 });
      expect(coverage("sum")).toEqual({ tests: 1, direct: 0 });
      expect(coverage("untested")).toBeUndefined();

      const entries = db.prepare(
        "SELECT label, symbol_id IS NOT NULL AS walkable, reach_symbols > 0 AS reaches FROM entry_points WHERE kind = 'test' ORDER BY line",
      ).all();
      expect(entries).toEqual([
        { label: "adds two numbers", walkable: 1, reaches: 1 },
        { label: "sums lists of %s", walkable: 1, reaches: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it("用例组按被测函数命名时，用例里的调用仍然连到真正的函数，而不是同名的用例组", async () => {
    const db = await scanFixture({
      "src/server.ts": "export function startServer(port: number) { return port; }\n",
      "src/server.test.ts": [
        'import { describe, expect, it } from "vitest";',
        'import { startServer } from "./server";',
        'describe("startServer", () => {',
        '  it("listens on the given port", () => { expect(startServer(1)).toBe(1); });',
        "});",
      ].join("\n"),
    });
    try {
      const target = db.prepare(
        `SELECT f.path FROM call_sites c JOIN symbols s ON s.id = c.target_symbol_id JOIN files f ON f.id = s.file_id
         WHERE c.callee_name = 'startServer'`,
      ).get() as { path: string } | undefined;
      expect(target?.path).toBe("src/server.ts");
      const coverage = db.prepare(
        `SELECT t.tests, t.direct FROM test_coverage t JOIN symbols s ON s.id = t.symbol_id
         JOIN files f ON f.id = s.file_id WHERE f.path = 'src/server.ts'`,
      ).get();
      expect(coverage).toEqual({ tests: 1, direct: 1 });
    } finally {
      db.close();
    }
  });

  it("增量扫描重新解析一个文件时，还在的符号沿用原来的 id，新加的才拿新 id", async () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-ids-"));
    roots.push(root);
    writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export function keep() { return 1; }\nexport class Box { open() { return 2; } }\n");
    await scanRepo({ root, structureOnly: true });
    const ids = () => {
      const db = openDb(indexPath(root), { readonly: true });
      try {
        return Object.fromEntries((db.prepare(
          "SELECT COALESCE(container || '.', '') || name AS name, id FROM symbols ORDER BY start_byte",
        ).all() as Array<{ name: string; id: number }>).map((row) => [row.name, row.id]));
      } finally {
        db.close();
      }
    };
    const before = ids();

    writeFileSync(join(root, "src/a.ts"), "export function added() { return 0; }\nexport function keep() { return 3; }\nexport class Box { open() { return 4; } }\n");
    await scanRepo({ root, structureOnly: true });
    const after = ids();
    expect(after["keep"]).toBe(before["keep"]);
    expect(after["Box"]).toBe(before["Box"]);
    expect(after["Box.open"]).toBe(before["Box.open"]);
    expect(Object.values(before)).not.toContain(after["added"]);
  });

  it("测试文件里按约定命名的函数和类也是用例；源码文件里同名函数不算", async () => {
    const db = await scanFixture({
      "app/store.py": "def save(x):\n    return x\n\ndef test_helper_in_source():\n    return 1\n",
      "tests/test_store.py": [
        "from app.store import save",
        "",
        "def test_save():",
        "    assert save(1) == 1",
        "",
        "class TestStore:",
        "    def test_again(self):",
        "        assert save(2) == 2",
        "",
        "def testing_helper():",
        "    return 0",
        "",
      ].join("\n"),
    });
    try {
      const marked = db.prepare(
        "SELECT name, test_kind AS kind FROM symbols WHERE test_kind IS NOT NULL ORDER BY start_line",
      ).all();
      expect(marked).toEqual([
        { name: "test_save", kind: "case" },
        { name: "TestStore", kind: "suite" },
        { name: "test_again", kind: "case" },
      ]);
      const save = db.prepare(
        "SELECT t.tests FROM test_coverage t JOIN symbols s ON s.id = t.symbol_id WHERE s.name = 'save'",
      ).get() as { tests: number } | undefined;
      expect(save?.tests).toBe(2);
    } finally {
      db.close();
    }
  });
});
