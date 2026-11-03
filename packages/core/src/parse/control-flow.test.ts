import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { scanRepo } from "../pipeline/scan.js";
import type { ControlBlock } from "../types.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-flow-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scanFixture(files: Record<string, string>): Promise<Db> {
  const root = mkdtempSync(join(tmpdir(), "repolens-flow-"));
  roots.push(root);
  writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await scanRepo({ root, fresh: true });
  return openDb(indexPath(root), { readonly: true });
}

function callsOf(db: Db, caller: string): Array<{ callee: string; blocks: ControlBlock[]; discarded: boolean }> {
  return (db.prepare(
    `SELECT c.callee_name AS callee, c.blocks, c.discarded FROM call_sites c JOIN symbols s ON s.id = c.caller_symbol_id
     WHERE s.name = ? ORDER BY c.line, c.end_byte`,
  ).all(caller) as Array<{ callee: string; blocks: string | null; discarded: number }>).map((row) => ({
    callee: row.callee,
    blocks: row.blocks ? (JSON.parse(row.blocks) as ControlBlock[]) : [],
    discarded: row.discarded === 1,
  }));
}

const shape = (blocks: ControlBlock[]) => blocks.map((b) => `${b.k}${b.t ? `(${b.t})` : ""}${b.x ? "!" : ""}`).join(" > ");

describe("调用所在的控制结构", () => {
  it("TS：守卫分支、else if、循环、try/catch、回调、短路调用，以及返回值没人用", async () => {
    const db = await scanFixture({
      "src/main.ts": `
        declare function log(m: string): void;
        declare function load(id: string): Promise<string>;
        declare function save(x: string): void;
        declare function fail(e: unknown): void;
        declare function render(x: string): string;
        export async function main(ids: string[], quiet: boolean) {
          if (ids.length === 0) {
            log("empty");
            return;
          }
          for (const id of ids) {
            try {
              const text = await load(id);
              save(text);
            } catch (err) {
              fail(err);
            }
          }
          if (quiet) render("q"); else if (ids.length > 3) render("many"); else render("few");
          ids.map((id) => render(id));
          quiet || log("done");
        }
      `,
    });
    try {
      expect(callsOf(db, "main").map((c) => [c.callee, shape(c.blocks), c.discarded])).toEqual([
        ["log", "if(ids.length === 0)!", true],
        ["load", "loop(for (const id of ids)) > try", false],
        ["save", "loop(for (const id of ids)) > try", true],
        ["fail", "loop(for (const id of ids)) > catch(err)", true],
        ["render", "if(quiet)", true],
        ["render", "else(quiet) > if(ids.length > 3)", true],
        ["render", "else(quiet) > else(ids.length > 3)", true],
        // Sort by end position: The call in the callback ends before the outer call ends
        ["render", "callback(map)", false],
        ["map", "", true],
        ["log", "if(!(quiet))", false],
      ]);
    } finally {
      db.close();
    }
  });

  it("箭头函数常量自己的函数体不算回调；Python 的 if / elif / try / except 也认得出", async () => {
    const db = await scanFixture({
      "src/a.ts": `
        declare function run(x: number): void;
        export const handler = (x: number) => {
          if (x > 1) run(x);
          setTimeout(() => run(0), 10);
        };
      `,
      "app/b.py": [
        "def process(items):",
        "    if not items:",
        "        raise ValueError('empty')",
        "    elif len(items) > 9:",
        "        trim(items)",
        "    try:",
        "        store(items)",
        "    except OSError as err:",
        "        report(err)",
        "",
      ].join("\n"),
    });
    try {
      expect(callsOf(db, "handler").map((c) => [c.callee, shape(c.blocks)])).toEqual([
        ["run", "if(x > 1)"],
        ["run", "callback(setTimeout)"],
        ["setTimeout", ""],
      ]);
      // An if with elif is an ordinary branch, not a guard; the condition of the elif is only evaluated if the first branch does not hold.
      expect(callsOf(db, "process").map((c) => [c.callee, shape(c.blocks)])).toEqual([
        ["ValueError", "if(not items)"],
        ["len", "else(not items)"],
        ["trim", "else(not items) > if(len(items) > 9)"],
        ["store", "try"],
        ["report", "catch(OSError as err)"],
      ]);
    } finally {
      db.close();
    }
  });
});
