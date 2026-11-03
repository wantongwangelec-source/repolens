import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write to a temporary file first and then rename it; even if it crashes halfway, it won't leave a half-finished JSON */
export function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * A local list (such as notes) under `.repolens/` stored as `{ version: 1, <key>: [...] }`.
 * When the file is corrupted, an error is reported directly; it cannot be treated as an empty list and written back, as that would overwrite the things the user has recorded.
 * Discard individual unrecognizable entries so that a single piece of bad data doesn't ruin the entire list.
 */
export class JsonListFile<T> {
  constructor(
    private readonly path: string,
    private readonly key: string,
    /** What to call this file when an error occurs, such as 'note file' */
    private readonly label: string,
    private readonly accept: (item: unknown) => item is T,
  ) {}

  read(): T[] {
    if (!existsSync(this.path)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new Error(`${this.label}无法解析：${this.path}（${(err as Error).message}）`);
    }
    const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)[this.key] : undefined;
    if (!Array.isArray(list)) throw new Error(`${this.label}格式不对：${this.path}`);
    return list.filter(this.accept);
  }

  write(items: readonly T[]): void {
    writeJsonAtomically(this.path, { version: 1, [this.key]: items });
  }

  /** Delete the matched entries; return false if none are matched, and do not write to the file */
  remove(matches: (item: T) => boolean): boolean {
    const items = this.read();
    const remaining = items.filter((item) => !matches(item));
    if (remaining.length === items.length) return false;
    this.write(remaining);
    return true;
  }
}
