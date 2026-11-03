import type { Db } from "../db/database.js";
import { SQL_LITERAL } from "../parse/ast-utils.js";

const NAME = String.raw`[\w$."\x60\[\]]+`;
const WRITES = [
  new RegExp(String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(${NAME})`, "gi"),
  new RegExp(String.raw`\bREPLACE\s+INTO\s+(${NAME})`, "gi"),
  new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?(${NAME})\s+SET\b`, "gi"),
  new RegExp(String.raw`\bDELETE\s+FROM\s+(${NAME})`, "gi"),
  new RegExp(String.raw`\bMERGE\s+INTO\s+(${NAME})`, "gi"),
];
/** The string of table names after FROM until the next clause; parentheses (subquery, table-valued function) are not recognized */
const FROM_LIST = /\bFROM\s+([^;()]+?)(?=\s+(?:WHERE|GROUP|ORDER|LIMIT|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|UNION|EXCEPT|INTERSECT|HAVING|ON|USING|RETURNING|WINDOW|MATCH)\b|\s*\)|\s*;|\s*$)/gi;
const JOIN = new RegExp(String.raw`\bJOIN\s+(${NAME})(?!\s*\()`, "gi");
const CTE = /\b(\w+)\s+AS\s*\(/gi;
const NOT_TABLES = new Set(["select", "values", "set", "where", "dual", "sqlite_master", "sqlite_schema", "information_schema", "lateral", "unnest"]);

/**
 * Which tables the SQL written in the code reads and writes. Only the SQL text in literals is recognized; ORM model methods are not included.
 * If you can't recognize it, it doesn't count, don't guess. The data table is one of the skeletons of the system: by looking at who writes to the 'files' table and who only reads it, you can immediately see where the data comes from and where it goes.
 */
export function analyzeDataAccess(db: Db): number {
  db.exec("DELETE FROM data_access");
  const rows = db.prepare(
    `SELECT c.id, c.caller_symbol_id AS symbolId, c.file_id AS fileId, c.line, c.argument_texts AS args
     FROM call_sites c JOIN files f ON f.id = c.file_id
     WHERE f.role = 'source' AND (c.argument_texts LIKE '%select%' OR c.argument_texts LIKE '%insert%'
       OR c.argument_texts LIKE '%update%' OR c.argument_texts LIKE '%delete%' OR c.argument_texts LIKE '%with%'
       OR c.argument_texts LIKE '%replace%' OR c.argument_texts LIKE '%merge%')`,
  ).all() as Array<{ id: number; symbolId: number | null; fileId: number; line: number; args: string }>;
  const insert = db.prepare(
    "INSERT INTO data_access (call_site_id, symbol_id, file_id, table_name, write, line) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let count = 0;
  for (const row of rows) {
    let args: unknown;
    try {
      args = JSON.parse(row.args);
    } catch {
      continue;
    }
    if (!Array.isArray(args)) continue;
    const sql = args.find((arg): arg is string => typeof arg === "string" && SQL_LITERAL.test(arg));
    if (!sql) continue;
    for (const table of sqlTables(sql)) {
      insert.run(row.id, row.symbolId, row.fileId, table.name, table.write ? 1 : 0, row.line);
      count++;
    }
  }
  return count;
}

export function sqlTables(literal: string): Array<{ name: string; write: boolean }> {
  const sql = ` ${literal} `
    .replace(/^\s*[a-zA-Z]{0,2}["'`]{1,3}|["'`]{1,3}\s*$/g, " ")
    .replace(/\$\{[^}]*\}/g, "?")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, " ");
  const ctes = new Set([...sql.matchAll(CTE)].map((match) => match[1]!.toLowerCase()));
  const out = new Map<string, boolean>();
  const add = (raw: string, write: boolean) => {
    const name = raw.replace(/["`[\]]/g, "").split(".").at(-1)?.trim() ?? "";
    const key = name.toLowerCase();
    if (!/^[A-Za-z_]\w*$/.test(name) || NOT_TABLES.has(key) || ctes.has(key) || key.startsWith("pragma_")) return;
    out.set(name, (out.get(name) ?? false) || write);
  };

  for (const pattern of WRITES) for (const match of sql.matchAll(pattern)) add(match[1]!, true);
  for (const match of sql.matchAll(FROM_LIST)) {
    // DELETE FROM AlreadyCalculated
    if (/\bDELETE\s$/i.test(sql.slice(Math.max(0, (match.index ?? 0) - 7), match.index))) continue;
    for (const part of match[1]!.split(",")) add(part.trim().split(/\s+/)[0] ?? "", false);
  }
  for (const match of sql.matchAll(JOIN)) add(match[1]!, false);
  return [...out].map(([name, write]) => ({ name, write }));
}
