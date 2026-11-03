import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { INDEX_DIR, type Db } from "./db/database.js";
import { ROOT_SCOPE } from "./db/queries.js";
import { JsonListFile } from "./json-file.js";
import type { NoteDto, NoteInputDto, NoteTargetDto } from "./types.js";

const NOTES_FILE = "notes.json";
const MAX_NOTE_CHARS = 20_000;
const MAX_QUESTION_CHARS = 2_000;
const NODE_ID = /^(?:(?:sym|file):\d+|(?:dir|pkg):.+)$/;

interface StoredNote {
  id: string;
  target: NoteTargetDto;
  text: string;
  question: string | null;
  createdAt: string;
  /** When taking notes, if the hash of the file's content is different from the current one, it indicates that the line numbers may have shifted. */
  fileHash: string | null;
}

/** The request itself has a problem (node does not exist, content is empty), which is different from errors in reading or writing the notes file. */
export class NoteInputError extends Error {}

/**
 * Notes exist separately in the JSON next to the index, rather than being put into index.db: the index can be
 * `scan --fresh` or upgrading the version requires a complete rebuild. Notes are things the user records themselves and cannot be lost along the way.
 */
export function notesPath(root: string): string {
  return join(root, INDEX_DIR, NOTES_FILE);
}

function notesFile(root: string): JsonListFile<StoredNote> {
  return new JsonListFile(notesPath(root), "notes", "笔记文件", isStoredNote);
}

export function listNotes(db: Db, root: string): NoteDto[] {
  const present = presenter(db);
  return notesFile(root).read().map(present);
}

export function addNote(db: Db, root: string, input: NoteInputDto): NoteDto {
  const text = input.text.trim().slice(0, MAX_NOTE_CHARS);
  if (text === "") throw new NoteInputError("笔记内容为空");
  const { target, fileHash } = resolveTarget(db, root, input.nodeId, input.lines ?? null);
  const question = input.question?.trim().slice(0, MAX_QUESTION_CHARS) || null;
  const note: StoredNote = { id: randomUUID(), target, text, question, createdAt: new Date().toISOString(), fileHash };
  const file = notesFile(root);
  file.write([...file.read(), note]);
  return presenter(db)(note);
}

export function deleteNote(root: string, id: string): boolean {
  return notesFile(root).remove((note) => note.id === id);
}

export function parseNoteInput(raw: unknown): NoteInputDto | null {
  if (!isRecord(raw)) return null;
  const { nodeId, lines, text, question } = raw;
  if (typeof nodeId !== "string" || !NODE_ID.test(nodeId) || typeof text !== "string") return null;
  if (lines !== undefined && lines !== null && !isLineRange(lines)) return null;
  if (question !== undefined && question !== null && typeof question !== "string") return null;
  return { nodeId, lines: lines ?? null, text, question: question ?? null };
}

function resolveTarget(
  db: Db,
  root: string,
  nodeId: string,
  lines: [number, number] | null,
): { target: NoteTargetDto; fileHash: string | null } {
  const numeric = Number(nodeId.slice(nodeId.indexOf(":") + 1));
  if (nodeId.startsWith("file:")) {
    const file = db.prepare("SELECT path, hash FROM files WHERE id = ?").get(numeric) as
      | { path: string; hash: string }
      | undefined;
    if (!file) throw new NoteInputError("文件不存在");
    return { target: { kind: "file", path: file.path, lines, symbol: null }, fileHash: file.hash };
  }
  if (nodeId.startsWith("sym:")) {
    const symbol = db.prepare(
      `SELECT s.name, s.container, s.start_line AS startLine, s.end_line AS endLine, f.path, f.hash
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    ).get(numeric) as
      | { name: string; container: string | null; startLine: number; endLine: number; path: string; hash: string }
      | undefined;
    if (!symbol) throw new NoteInputError("符号不存在");
    return {
      target: {
        kind: "file",
        path: symbol.path,
        lines: lines ?? [symbol.startLine, symbol.endLine],
        symbol: symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name,
      },
      fileHash: symbol.hash,
    };
  }
  if (!scopeExists(db, nodeId)) throw new NoteInputError("节点不存在");
  return { target: { kind: "scope", id: nodeId, label: scopeLabel(root, nodeId) }, fileHash: null };
}

function presenter(db: Db): (note: StoredNote) => NoteDto {
  const fileByPath = db.prepare("SELECT id, hash FROM files WHERE path = ?");
  return (note) => {
    const base = { id: note.id, target: note.target, text: note.text, question: note.question, createdAt: note.createdAt };
    if (note.target.kind === "scope") {
      return { ...base, nodeId: scopeExists(db, note.target.id) ? note.target.id : null, stale: false };
    }
    const file = fileByPath.get(note.target.path) as { id: number; hash: string } | undefined;
    return {
      ...base,
      nodeId: file ? `file:${file.id}` : null,
      stale: file !== undefined && note.fileHash !== null && file.hash !== note.fileHash,
    };
  };
}

function scopeExists(db: Db, id: string): boolean {
  if (id === ROOT_SCOPE) return true;
  if (id.startsWith("dir:")) return db.prepare("SELECT 1 FROM directories WHERE path = ?").get(id.slice(4)) !== undefined;
  if (id.startsWith("pkg:")) return db.prepare("SELECT 1 FROM packages WHERE name = ?").get(id.slice(4)) !== undefined;
  return false;
}

function scopeLabel(root: string, id: string): string {
  if (id === ROOT_SCOPE) return basename(root);
  const rest = id.slice(4);
  return id.startsWith("pkg:") ? rest : (rest.split("/").at(-1) ?? rest);
}

function isStoredNote(value: unknown): value is StoredNote {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["text"] !== "string") return false;
  const target = value["target"];
  if (!isRecord(target)) return false;
  if (target["kind"] === "file") {
    return typeof target["path"] === "string" && (target["lines"] === null || isLineRange(target["lines"]));
  }
  return target["kind"] === "scope" && typeof target["id"] === "string" && typeof target["label"] === "string";
}

function isLineRange(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    value.every((n) => Number.isInteger(n) && n >= 1) && (value[0] as number) <= (value[1] as number);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
