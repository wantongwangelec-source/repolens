/**
 * Inside the repository, POSIX relative paths are used exclusively, with the root directory represented as `.`.
 *
 * Node:path is not used because it produces backslashes on Windows, and the path needs to be used as a database primary key.
 * Used with the front-end node id, it must be cross-platform and stable.
 */

export function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith("/");
  const segments: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const last = segments.at(-1);
      if (last !== undefined && last !== "..") segments.pop();
      else if (!isAbsolute) segments.push("..");
      continue;
    }
    segments.push(part);
  }

  const joined = segments.join("/");
  if (isAbsolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

export function joinPosix(...parts: string[]): string {
  const meaningful = parts.filter((p) => p !== "" && p !== ".");
  if (meaningful.length === 0) return ".";
  return normalizePosix(meaningful.join("/"));
}

/** Get the parent directory; the parent directory of the root directory is still `.` */
export function dirOf(path: string): string {
  const normalized = normalizePosix(path);
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return ".";
  return normalized.slice(0, slash);
}

export function baseName(path: string): string {
  const normalized = normalizePosix(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function stripExtension(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return path;
  return path.slice(0, path.length - (base.length - dot));
}

/** Returns all ancestor directories from the root to this path, including the directory itself, excluding `.` */
export function ancestorDirs(path: string): string[] {
  const dir = dirOf(path);
  if (dir === ".") return [];
  const parts = dir.split("/");
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function depthOf(path: string): number {
  if (path === "." || path === "") return 0;
  return path.split("/").length;
}

export function isWithin(dir: string, path: string): boolean {
  if (dir === ".") return true;
  return path === dir || path.startsWith(`${dir}/`);
}
