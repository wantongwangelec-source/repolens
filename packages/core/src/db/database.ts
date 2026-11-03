import Database from "better-sqlite3";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type Db = Database.Database;

export const INDEX_DIR = ".repolens";
export const INDEX_FILE = "index.db";

export function indexPath(repoRoot: string): string {
  return join(repoRoot, INDEX_DIR, INDEX_FILE);
}

export interface OpenOptions {
  /** Open as read-only, for server use */
  readonly?: boolean;
  /** Discard existing data and rebuild */
  fresh?: boolean;
}

export function openDb(dbPath: string, opts: OpenOptions = {}): Db {
  if (opts.readonly) {
    if (!existsSync(dbPath)) {
      throw new Error(`索引不存在：${dbPath}\n先运行 \`repolens scan\``);
    }
    const db = new Database(dbPath, { readonly: true });
    const version = readSchemaVersion(db);
    if (version !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `索引版本过期（当前 ${version ?? "未知"}，需要 ${SCHEMA_VERSION}）：${dbPath}\n` +
          "运行 `repolens scan` 更新索引",
      );
    }
    db.pragma("journal_mode = WAL");
    return db;
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  if (opts.fresh) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(dbPath + suffix, { force: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // During batch writes, putting the temporary structure in memory saves considerable I/O when scanning 400,000 rows.
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000");

  const existing = readSchemaVersion(db);
  if (existing !== null && existing !== SCHEMA_VERSION) {
    const steps: Array<(db: Db) => void> = [];
    for (let version = Number(existing); version < Number(SCHEMA_VERSION); version++) {
      const step = MIGRATIONS[String(version)];
      if (!step) break;
      steps.push(step);
    }
    if (steps.length !== Number(SCHEMA_VERSION) - Number(existing)) {
      db.close();
      return openDb(dbPath, { ...opts, fresh: true });
    }
    transact(db, () => {
      for (const step of steps) step(db);
    });
  }

  db.exec(SCHEMA_SQL);
  setMeta(db, "schema_version", SCHEMA_VERSION);
  return db;
}

/**
 * Migrate changes that only add columns or delete derived tables in place, without rebuilding the entire database: the AI results in summaries are generated at a cost.
 * After migration, the new columns in the old rows only have default values. Rely on increasing EXTRACTOR_VERSION at the same time so that the next scan re-parses everything.
 */
const MIGRATIONS: Record<string, (db: Db) => void> = {
  "5": (db) => {
    addColumns(db, "call_sites", {
      end_byte: "INTEGER NOT NULL DEFAULT 0",
      name_line: "INTEGER NOT NULL DEFAULT 0",
      name_col: "INTEGER NOT NULL DEFAULT 0",
      resolution: "TEXT NOT NULL DEFAULT 'unresolved'",
      target_symbol_id: "INTEGER REFERENCES symbols(id) ON DELETE SET NULL",
      target_name: "TEXT",
      candidates: "TEXT",
      io_kind: "TEXT",
    });
    addColumns(db, "entry_points", {
      reach_symbols: "INTEGER NOT NULL DEFAULT 0",
      reach_files: "INTEGER NOT NULL DEFAULT 0",
      reach_io: "TEXT NOT NULL DEFAULT ''",
    });
    db.exec(`
      DROP TABLE IF EXISTS trace_steps;
      DROP TABLE IF EXISTS traces;
      DROP TABLE IF EXISTS boundaries;
      DELETE FROM summaries WHERE target_kind = 'trace';
    `);
  },
  "6": (db) => {
    addColumns(db, "call_sites", { receiver_type: "TEXT" });
  },
  // The new table is created from SCHEMA_SQL's CREATE IF NOT EXISTS, here only adding the columns from the old table.
  "7": (db) => {
    addColumns(db, "symbols", { test_kind: "TEXT", implemented: "INTEGER NOT NULL DEFAULT 1" });
    addColumns(db, "call_sites", { blocks: "TEXT", discarded: "INTEGER NOT NULL DEFAULT 0" });
  },
  // Only added two new tables for submission details; fill them in during the next full scan.
  "8": () => {},
};

function addColumns(db: Db, table: string, columns: Record<string, string>): void {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  // The tables have not yet been created by SCHEMA_SQL according to the latest structure.
  if (present.size === 0) return;
  for (const [name, definition] of Object.entries(columns)) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/** `open` uses it to determine whether an existing index can serve directly; read-only probing, does not trigger migration or rebuilding. */
export function isIndexCurrent(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return readSchemaVersion(db) === SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function readSchemaVersion(db: Db): string | null {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) return null;
  return getMeta(db, "schema_version");
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function getMetaJson<T>(db: Db, key: string, fallback: T): T {
  const raw = getMeta(db, key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setMetaJson(db: Db, key: string, value: unknown): void {
  setMeta(db, key, JSON.stringify(value));
}

/** Run a batch of writes in a single transaction. better-sqlite3 is a synchronous API, so there is no need to handle concurrency here. */
export function transact<T>(db: Db, fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}
