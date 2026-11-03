import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFindings } from "../db/queries.js";
import { indexPath, openDb } from "../db/database.js";
import { isAiAssisted } from "./history.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-history-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function commit(root: string, message: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git("add", "-A");
  git("commit", "-qm", message);
}

describe("git 历史", () => {
  it("认得出 AI 参与的提交：Co-authored-by 里的智能体，或标明由它生成", () => {
    expect(isAiAssisted("fix: x\n\nCo-authored-by: Cursor <cursoragent@cursor.com>")).toBe(true);
    expect(isAiAssisted("feat\n\n🤖 Generated with [Claude Code](https://claude.ai)\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBe(true);
    expect(isAiAssisted("chore\n\nCo-authored-by: Alice <alice@example.com>")).toBe(false);
    expect(isAiAssisted("docs: explain the cursor position in the editor")).toBe(false);
  });

  it("每个文件的改动次数和 AI 参与次数；总是一起改、代码里又没有依赖的源码文件进体检", async () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-history-"));
    roots.push(root);
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
    write(root, {
      ".repolens.json": JSON.stringify({ llm: { enabled: false } }),
      "src/server/protocol.ts": "export const VERSION = 1;\n",
      "src/client/codec.ts": "export function decode(x: string) { return x; }\n",
      "src/other.ts": "export const other = 0;\n",
    });
    commit(root, "init");
    for (let i = 1; i <= 4; i++) {
      write(root, {
        "src/server/protocol.ts": `export const VERSION = ${i + 1};\n`,
        "src/client/codec.ts": `export function decode(x: string) { return x + ${i}; }\n`,
      });
      commit(root, i % 2 === 0 ? `bump ${i}\n\nCo-authored-by: Claude <noreply@anthropic.com>` : `bump ${i}`);
    }
    // A separate commit for changes in another file: without them, the two files are almost changed in every commit, changing them together doesn't indicate anything
    for (let i = 1; i <= 6; i++) {
      write(root, { "src/other.ts": `export const other = ${i};\n` });
      commit(root, `touch other ${i}`);
    }

    await scanRepo({ root, fresh: true });
    const db = openDb(indexPath(root), { readonly: true });
    try {
      const history = db.prepare("SELECT path, commits, recent, authors, ai_commits AS ai FROM file_history ORDER BY path").all();
      expect(history).toEqual([
        { path: ".repolens.json", commits: 1, recent: 1, authors: 1, ai: 0 },
        { path: "src/client/codec.ts", commits: 5, recent: 5, authors: 1, ai: 2 },
        { path: "src/other.ts", commits: 7, recent: 7, authors: 1, ai: 0 },
        { path: "src/server/protocol.ts", commits: 5, recent: 5, authors: 1, ai: 2 },
      ]);
      const coupling = getFindings(db, { kind: "coupling" });
      expect(coupling).toHaveLength(1);
      expect(coupling[0]?.title).toBe("codec.ts 和 protocol.ts 总是一起改，代码里却没有依赖");
    } finally {
      db.close();
    }
  });
});
