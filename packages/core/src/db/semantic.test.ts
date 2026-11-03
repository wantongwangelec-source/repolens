import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./database.js";
import { getCachedSemantic, invalidateCachedSemantic, putCachedSemantic } from "./semantic.js";

let db: Db | null = null;
let dir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("semantic cache", () => {
  it("只命中相同源码指纹并能清掉过期内容", () => {
    dir = mkdtempSync(join(tmpdir(), "repolens-llm-cache-"));
    db = openDb(join(dir, "index.db"));
    putCachedSemantic(db, {
      targetKind: "symbol", targetKey: "src/a.ts#run", flavor: "summary",
      lang: "zh", content: "旧摘要", sourceHash: "hash-a", model: "test",
    });

    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh", "hash-a")?.content).toBe("旧摘要");
    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh", "hash-a", "other-model")).toBeNull();
    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh", "hash-b")).toBeNull();

    invalidateCachedSemantic(db, "symbol", "src/a.ts#run", "hash-b");
    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh")).toBeNull();
  });
});
