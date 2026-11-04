import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb } from "../db/database.js";
import { hashContent } from "../discovery/walk.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-language-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("多语言扫描", () => {
  it("解析 Vue、保留未知文本并隐藏未知二进制", async () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-language-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
    writeFileSync(join(root, "src/helper.js"), "export function helper() {}\n");
    writeFileSync(join(root, "src/App.vue"), [
      "<template><p>你好</p></template>",
      "<script>",
      'import { helper } from "./helper"',
      "export default { methods: { load() { helper() } } }",
      "</script>",
    ].join("\n"));
    writeFileSync(join(root, "src/workflow.dsl"), "step build\nstep deploy\n");
    writeFileSync(join(root, "src/blob.dat"), Buffer.from([0, 1, 2, 3, 4]));

    await scanRepo({ root, fresh: true });
    let db = openDb(indexPath(root));
    try {
      expect(file(db, "src/App.vue")).toMatchObject({ language: "vue", role: "source", parsed: 1 });
      expect(file(db, "src/workflow.dsl")).toMatchObject({ language: "other", role: "source" });
      expect(file(db, "src/blob.dat")).toMatchObject({ language: "other", role: "asset", loc: 0 });
      expect((db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?")
        .get(file(db, "src/App.vue").id) as { n: number }).n).toBeGreaterThan(0);
      expect(db.prepare(
        `SELECT target.path FROM imports i JOIN files source ON source.id = i.file_id
         JOIN files target ON target.id = i.target_file_id WHERE source.path = 'src/App.vue'`,
      ).get()).toEqual({ path: "src/helper.js" });

      // Simulate other/asset in the old index; even if the content hash does not change, it must be re-parsed due to category changes.
      db.prepare("UPDATE files SET language = 'other', role = 'asset', parsed = 0 WHERE path = 'src/App.vue'").run();
    } finally {
      db.close();
    }

    await scanRepo({ root });
    db = openDb(indexPath(root));
    try {
      expect(file(db, "src/App.vue")).toMatchObject({ language: "vue", role: "source", parsed: 1 });
    } finally {
      db.close();
    }
  });

  it("中文出现在符号之前时，符号哈希仍然覆盖符号本身", async () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-language-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
    writeFileSync(join(root, "src/greet.ts"), "// 问候语\nfunction greet() { return 1 }\n");
    writeFileSync(join(root, "src/Greet.vue"), [
      "<template><p>你好，世界</p></template>",
      "<script>",
      "function greet() { return 1 }",
      "</script>",
    ].join("\n"));

    await scanRepo({ root, fresh: true });
    const db = openDb(indexPath(root));
    try {
      const hashes = db.prepare(
        `SELECT f.path, s.hash FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name = 'greet' ORDER BY f.path`,
      ).all();
      const expected = hashContent("function greet() { return 1 }");
      expect(hashes).toEqual([
        { path: "src/Greet.vue", hash: expected },
        { path: "src/greet.ts", hash: expected },
      ]);
    } finally {
      db.close();
    }
  });
});

function file(db: ReturnType<typeof openDb>, path: string) {
  return db.prepare(
    "SELECT id, language, role, loc, parsed FROM files WHERE path = ?",
  ).get(path) as { id: number; language: string; role: string; loc: number; parsed: number };
}
