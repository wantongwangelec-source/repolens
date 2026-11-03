import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMetaJson, type Db } from "../db/database.js";
import type { FindingRow } from "../db/writer.js";
import { baseName, dirOf, joinPosix } from "../resolve/path-utils.js";

/** To be considered 'always editing together,' it has to be many times more frequent than randomly running into each other: large files that are edited every day and edited with anyone. */
const MIN_LIFT = 2;
/** co_changes is recorded after being received 3 times (used in 'files often changed together' in file details), more times are required if reporting an issue */
const MIN_TOGETHER = 4;
const MAX_COUPLINGS = 30;

/**
 * Hidden coupling: always changed together in git history, but there is no dependency in the code (direct import, or through the same
 * Indirect connections between files don't count). Changing one place requires changing another, yet on the static graph they have no relation——this is precisely AI modifying code
 * The easiest place to overlook: it only changed the current file.
 *
 * Only look at the source code to the source code; the key files that are modified every day (dictionaries, routing tables) are modified together with everyone, so use degree of improvement to exclude them.
 */
export function detectCoupling(db: Db, out: FindingRow[]): number {
  const history = getMetaJson<{ commits: number } | null>(db, "history", null);
  if (!history || history.commits === 0) return 0;
  const pairs = db.prepare(
    `SELECT c.a, c.b, c.together, ha.commits AS ca, hb.commits AS cb, fa.id AS aId, fb.id AS bId
     FROM co_changes c
     JOIN file_history ha ON ha.path = c.a JOIN file_history hb ON hb.path = c.b
     JOIN files fa ON fa.path = c.a AND fa.role = 'source' JOIN files fb ON fb.path = c.b AND fb.role = 'source'`,
  ).all() as Array<{ a: string; b: string; together: number; ca: number; cb: number; aId: number; bId: number }>;
  if (pairs.length === 0) return 0;

  const neighbors = new Map<number, Set<number>>();
  const link = (x: number, y: number) => {
    const set = neighbors.get(x);
    if (set) set.add(y); else neighbors.set(x, new Set([y]));
  };
  for (const edge of db.prepare(
    `SELECT src_id AS src, dst_id AS dst FROM edges
     WHERE src_kind = 'file' AND dst_kind = 'file' AND type IN ('imports', 'references', 'http')`,
  ).all() as Array<{ src: number; dst: number }>) {
    link(edge.src, edge.dst);
    link(edge.dst, edge.src);
  }
  const related = (a: number, b: number) => {
    const na = neighbors.get(a);
    const nb = neighbors.get(b);
    if (!na || !nb) return false;
    if (na.has(b)) return true;
    for (const x of na) if (nb.has(x)) return true;
    return false;
  };

  const hidden = pairs
    .map((pair) => ({ ...pair, lift: (pair.together * history.commits) / Math.max(1, pair.ca * pair.cb) }))
    .filter((pair) => pair.together >= MIN_TOGETHER && pair.lift >= MIN_LIFT && !related(pair.aId, pair.bId))
    .sort((x, y) => y.together - x.together || y.lift - x.lift)
    .slice(0, MAX_COUPLINGS);

  for (const pair of hidden) {
    const title = `${baseName(pair.a)} 和 ${baseName(pair.b)} 总是一起改，代码里却没有依赖`;
    const detail = [
      `近一年有 ${pair.together} 次提交同时改了这两个文件（各自改过 ${pair.ca} / ${pair.cb} 次）：`,
      pair.a,
      pair.b,
      "两者之间没有 import 关系，也不经过同一个文件相连。这种耦合在依赖图上看不见：改一处时多半也得改另一处，",
      "通常意味着两边各自写了一份同样的约定（格式、协议、配置键），可以考虑抽到一处。",
    ].join("\n");
    for (const [id, path] of [[pair.aId, pair.a], [pair.bId, pair.b]] as const) {
      out.push({
        kind: "coupling",
        severity: "low",
        scopeKind: "file",
        scopeKey: `file:${id}`,
        path,
        title,
        detail,
        related: [`file:${pair.aId}`, `file:${pair.bId}`],
        groupKey: `coupling:${pair.a}\u0000${pair.b}`,
      });
    }
  }
  return hidden.length;
}

const PATH_TOKEN = /^(?!\/|~|[a-z]+:)[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,8}$/;
const SKIP_PARTS = /(?:^|\/)(?:node_modules|dist|build|out|coverage|target|\.repolens|\.git|vendor)\//;
const CODE_SPAN = /`([^`\n]+)`/g;
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MAX_DOC_BYTES = 512 * 1024;

/**
 * The repository path referenced in the document no longer exists. The README and design documents reflect the author's intentions; the code has been moved or renamed.
 * After deleting it, the document still points to the old path, and the reader will be led to a place that doesn't exist—what is 'said' and what is 'done' begin to separate.
 *
 * Two types of references are judged separately: relative links `[x](docs/a.md)` are explicit jumps, and if they can't point, they are broken links; those inside backticks
 * Paths are often examples or files from other repositories, and only the git history proves that they once existed in this repository and were later deleted or renamed.
 * It is considered expired. As long as there is any file in the warehouse that ends with it, it is considered to exist, and it is better to underreport. External links, absolute paths, wildcards,
 * Build output directories are completely ignored.
 */
export function detectStaleDocs(db: Db, root: string, out: FindingRow[]): number {
  const docs = db.prepare(
    "SELECT id, path FROM files WHERE role = 'docs' AND (path LIKE '%.md' OR path LIKE '%.mdx' OR path LIKE '%.markdown')",
  ).all() as Array<{ id: number; path: string }>;
  if (docs.length === 0) return 0;
  const indexed = (db.prepare("SELECT path FROM files").all() as Array<{ path: string }>).map((row) => row.path);
  const known = new Set(indexed);
  const suffixes = new Set<string>();
  for (const path of indexed) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) suffixes.add(parts.slice(i).join("/"));
  }
  const exists = (docDir: string, ref: string): boolean => {
    if (known.has(ref) || suffixes.has(ref)) return true;
    for (const candidate of [joinPosix(docDir, ref), ref]) {
      if (candidate.startsWith("..")) continue;
      if (known.has(candidate) || existsSync(join(root, ...candidate.split("/")))) return true;
    }
    return false;
  };

  let deleted: Set<string> | null = null;
  const wasDeleted = (ref: string): boolean => {
    deleted ??= deletedPaths(root);
    if (deleted.has(ref)) return true;
    for (const path of deleted) if (path.endsWith(`/${ref}`)) return true;
    return false;
  };

  let count = 0;
  for (const doc of docs) {
    let text: string;
    try {
      if (statSync(join(root, doc.path)).size > MAX_DOC_BYTES) continue;
      text = readFileSync(join(root, doc.path), "utf8");
    } catch {
      continue;
    }
    const docDir = dirOf(doc.path);
    const missing = new Map<string, number>();
    const consider = (raw: string, index: number, link: boolean) => {
      const ref = raw.replace(/^\.\//, "").replace(/[#?].*$/, "").replace(/:\d+(?:-\d+)?$/, "");
      if (!PATH_TOKEN.test(ref) || SKIP_PARTS.test(`${ref}/`) || /[*{}<>$]/.test(ref) || missing.has(ref)) return;
      if (exists(docDir, ref) || (!link && !wasDeleted(ref))) return;
      missing.set(ref, text.slice(0, index).split("\n").length);
    };
    for (const match of text.matchAll(CODE_SPAN)) consider(match[1]!.trim(), match.index ?? 0, false);
    for (const match of text.matchAll(LINK)) {
      const target = match[1]!;
      if (!/^(?:https?:|mailto:|#)/i.test(target)) consider(target, match.index ?? 0, true);
    }
    if (missing.size === 0) continue;
    count++;
    const refs = [...missing].slice(0, 12);
    out.push({
      kind: "stale-doc",
      severity: "low",
      scopeKind: "file",
      scopeKey: `file:${doc.id}`,
      path: doc.path,
      title: `文档里引用了 ${missing.size} 个已经不存在的路径`,
      detail: [
        "这些路径在仓库里找不到了：多半是代码挪过、改过名或删掉了，文档没跟着改。",
        ...refs.map(([ref, line]) => `L${line}  ${ref}`),
        ...(missing.size > refs.length ? [`…另有 ${missing.size - refs.length} 处`] : []),
      ].join("\n"),
      related: [`file:${doc.id}`],
      groupKey: `stale-doc:${doc.path}`,
    });
  }
  return count;
}

/** The path that was deleted in git history (including the old name before renaming); empty if not in git */
function deletedPaths(root: string): Set<string> {
  try {
    const raw = execFileSync(
      "git",
      [
        "--no-pager", "-C", root, "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
        "log", "--relative", "--no-renames", "--diff-filter=D", "--name-only", "--format=", "-n20000",
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Set(raw.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}
