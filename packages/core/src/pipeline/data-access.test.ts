import { describe, expect, it } from "vitest";
import { sqlTables } from "./data-access.js";

describe("SQL 字面量里的表", () => {
  it("读写分开：INSERT / UPDATE / DELETE 算写，FROM / JOIN 算读", () => {
    expect(sqlTables("`SELECT f.id, s.name FROM files f JOIN symbols s ON s.file_id = f.id WHERE f.role = 'source'`"))
      .toEqual([{ name: "files", write: false }, { name: "symbols", write: false }]);
    expect(sqlTables(`"INSERT INTO summaries (a, b) VALUES (?, ?) ON CONFLICT(a) DO UPDATE SET b = excluded.b"`))
      .toEqual([{ name: "summaries", write: true }]);
    expect(sqlTables(`"UPDATE call_sites SET io_kind = ? WHERE id = ?"`)).toEqual([{ name: "call_sites", write: true }]);
    expect(sqlTables(`"DELETE FROM findings WHERE id IN (SELECT id FROM stale)"`))
      .toEqual([{ name: "findings", write: true }, { name: "stale", write: false }]);
  });

  it("逗号连接的多表、CTE、表值函数和插值都不会被误认", () => {
    expect(sqlTables("`SELECT * FROM a, b AS bb WHERE a.id = bb.id`")).toEqual([
      { name: "a", write: false },
      { name: "b", write: false },
    ]);
    expect(sqlTables("`WITH recent AS (SELECT * FROM commits) SELECT * FROM recent JOIN authors USING (id)`")).toEqual([
      { name: "commits", write: false },
      { name: "authors", write: false },
    ]);
    expect(sqlTables("`SELECT value FROM json_each(?)`")).toEqual([]);
    expect(sqlTables("`SELECT id FROM files WHERE id IN (${placeholders})`")).toEqual([{ name: "files", write: false }]);
  });
});
