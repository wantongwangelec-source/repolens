import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db/database.js";
import { addNote, deleteNote, listNotes, NoteInputError, notesPath, parseNoteInput } from "./notes.js";

let repo: string;
let db: Db;
let fileId: number;
let symbolId: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "repolens-notes-"));
  db = openDb(join(repo, ".repolens", "index.db"));
  db.prepare("INSERT INTO packages (name, dir, manager) VALUES (?, ?, ?)").run("@demo/app", ".", "npm");
  db.prepare("INSERT INTO directories (path, parent_path, name, depth) VALUES (?, ?, ?, ?)").run("src", ".", "src", 1);
  fileId = insertFile("src/nn.py", "hash-1");
  symbolId = Number(db.prepare(
    `INSERT INTO symbols (file_id, name, kind, container, start_line, end_line, start_byte, end_byte)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(fileId, "__call__", "method", "Neuron", 12, 20, 0, 0).lastInsertRowid);
});

afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

function insertFile(path: string, hash: string): number {
  return Number(db.prepare(
    `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(path, "src", basename(path), "python", "source", 30, 600, hash).lastInsertRowid);
}

describe("笔记", () => {
  it("按路径和行号保存，不依赖扫描期的节点 id", () => {
    const onLines = addNote(db, repo, { nodeId: `file:${fileId}`, lines: [3, 5], text: "  这里算梯度  ", question: "这段在干嘛？" });
    const onSymbol = addNote(db, repo, { nodeId: `sym:${symbolId}`, text: "前向计算" });
    const onScope = addNote(db, repo, { nodeId: "dir:src", text: "源码目录" });
    const onPackage = addNote(db, repo, { nodeId: "pkg:@demo/app", text: "整个包" });
    const onRoot = addNote(db, repo, { nodeId: "dir:.", text: "仓库根" });

    expect(onLines).toMatchObject({
      target: { kind: "file", path: "src/nn.py", lines: [3, 5], symbol: null },
      text: "这里算梯度", question: "这段在干嘛？", nodeId: `file:${fileId}`, stale: false,
    });
    expect(onSymbol.target).toEqual({ kind: "file", path: "src/nn.py", lines: [12, 20], symbol: "Neuron.__call__" });
    expect(onScope.target).toEqual({ kind: "scope", id: "dir:src", label: "src" });
    expect(onPackage.target).toEqual({ kind: "scope", id: "pkg:@demo/app", label: "@demo/app" });
    expect(onRoot.target).toEqual({ kind: "scope", id: "dir:.", label: basename(repo) });

    expect(readFileSync(notesPath(repo), "utf8")).not.toMatch(/"(?:file|sym):\d+"/);
    expect(listNotes(db, repo).map((note) => note.id)).toEqual(
      [onLines, onSymbol, onScope, onPackage, onRoot].map((note) => note.id),
    );
  });

  it("重新扫描后换算到新的文件 id，文件改过就标记行号可能过期", () => {
    addNote(db, repo, { nodeId: `file:${fileId}`, lines: [3, 5], text: "笔记" });
    db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
    const rescanned = insertFile("src/nn.py", "hash-2");

    expect(listNotes(db, repo)[0]).toMatchObject({ nodeId: `file:${rescanned}`, stale: true });

    db.prepare("DELETE FROM files WHERE id = ?").run(rescanned);
    expect(listNotes(db, repo)[0]).toMatchObject({ nodeId: null, stale: false });
  });

  it("删除笔记，删不存在的笔记返回 false", () => {
    const first = addNote(db, repo, { nodeId: `file:${fileId}`, text: "一" });
    const second = addNote(db, repo, { nodeId: `file:${fileId}`, text: "二" });

    expect(deleteNote(repo, first.id)).toBe(true);
    expect(deleteNote(repo, first.id)).toBe(false);
    expect(listNotes(db, repo).map((note) => note.id)).toEqual([second.id]);
  });

  it("拒绝空内容和不存在的节点", () => {
    expect(() => addNote(db, repo, { nodeId: `file:${fileId}`, text: "  \n" })).toThrow(NoteInputError);
    expect(() => addNote(db, repo, { nodeId: "file:999", text: "笔记" })).toThrow(NoteInputError);
    expect(() => addNote(db, repo, { nodeId: "dir:missing", text: "笔记" })).toThrow(NoteInputError);
  });

  it("笔记文件损坏时报错，不覆盖原文件", () => {
    writeFileSync(notesPath(repo), "{ broken");

    expect(() => listNotes(db, repo)).toThrow(/无法解析/);
    expect(() => addNote(db, repo, { nodeId: `file:${fileId}`, text: "笔记" })).toThrow(/无法解析/);
    expect(readFileSync(notesPath(repo), "utf8")).toBe("{ broken");
  });

  it("校验请求体", () => {
    expect(parseNoteInput({ nodeId: "file:1", text: "x" })).toEqual({ nodeId: "file:1", lines: null, text: "x", question: null });
    expect(parseNoteInput({ nodeId: "file:1", text: "x", lines: [5, 3] })).toBeNull();
    expect(parseNoteInput({ nodeId: "file:1", text: "x", lines: [0, 3] })).toBeNull();
    expect(parseNoteInput({ nodeId: "../etc", text: "x" })).toBeNull();
    expect(parseNoteInput({ nodeId: "file:1" })).toBeNull();
  });
});
