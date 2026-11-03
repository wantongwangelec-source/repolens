import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMeta, openDb } from "./database.js";
import { SCHEMA_VERSION } from "./schema.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** In v5, the tables related to migration are taken directly from the schema at that time. */
const V5_SQL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE call_sites (
    id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, caller_symbol_id INTEGER, callee_name TEXT NOT NULL,
    receiver TEXT, callee_path TEXT, call_kind TEXT NOT NULL, arg_count INTEGER NOT NULL DEFAULT 0,
    argument_texts TEXT NOT NULL DEFAULT '[]', line INTEGER NOT NULL
  );
  CREATE TABLE entry_points (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, framework TEXT, symbol_id INTEGER, file_id INTEGER NOT NULL,
    line INTEGER NOT NULL, label TEXT NOT NULL, method TEXT, route TEXT, confidence TEXT NOT NULL, evidence TEXT NOT NULL
  );
  CREATE TABLE summaries (
    id INTEGER PRIMARY KEY, target_kind TEXT NOT NULL, target_key TEXT NOT NULL, flavor TEXT NOT NULL,
    lang TEXT NOT NULL, content TEXT NOT NULL, source_hash TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE boundaries (id INTEGER PRIMARY KEY);
  CREATE TABLE traces (id INTEGER PRIMARY KEY);
  CREATE TABLE trace_steps (id INTEGER PRIMARY KEY);
  INSERT INTO meta VALUES ('schema_version', '5');
  INSERT INTO summaries (target_kind, target_key, flavor, lang, content, source_hash, model, created_at) VALUES
    ('symbol', 'src/a.ts#run', 'summary-v2', 'zh', '花钱生成的摘要', 'h', 'm', 'now'),
    ('trace', 'abc', 'narrative', 'zh', '{}', 'abc', 'm', 'now');
`;

describe("openDb", () => {
  it("v5 索引逐版就地迁移到当前版本：补列、删旧链路表，AI 摘要保留", () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-migrate-"));
    roots.push(root);
    const path = join(root, "index.db");
    const old = new Database(path);
    old.exec(V5_SQL);
    old.close();

    const db = openDb(path);
    try {
      expect(getMeta(db, "schema_version")).toBe(SCHEMA_VERSION);
      const columns = (table: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns("call_sites")).toEqual(expect.arrayContaining([
        "end_byte", "name_line", "name_col", "resolution", "target_symbol_id", "target_name", "candidates", "io_kind",
        "receiver_type", "blocks", "discarded",
      ]));
      expect(columns("entry_points")).toEqual(expect.arrayContaining(["reach_symbols", "reach_files", "reach_io"]));
      expect(columns("symbols")).toContain("test_kind");
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(["io_reach", "test_coverage", "data_access", "file_history", "co_changes"]));
      expect(tables).not.toContain("traces");
      expect(tables).not.toContain("trace_steps");
      expect(tables).not.toContain("boundaries");
      expect(db.prepare("SELECT target_kind, content FROM summaries").all()).toEqual([
        { target_kind: "symbol", content: "花钱生成的摘要" },
      ]);
    } finally { db.close(); }
  });
});
