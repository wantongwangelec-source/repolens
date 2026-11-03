import type { FileHistoryDto } from "../types.js";
import type { Db } from "./database.js";
import { inBatches } from "./scope.js";

const CO_CHANGED_LISTED = 8;

export interface CommitCounts {
  commits: number;
  /** Last 90 days */
  recent: number;
  ai: number;
}

/**
 * The number of submissions of a set of files, deduplicated by submission: if a single submission changes five files in a module, it only counts as one.
 * It is null when history has not been read.
 */
export function commitCounts(db: Db, fileIds: Iterable<number>): CommitCounts | null {
  const ids = [...fileIds];
  if (ids.length === 0) return null;
  const commits = new Set(inBatches(ids, (batch) => db.prepare(
    `SELECT DISTINCT h.commit_id AS id FROM history_files h JOIN files f ON f.path = h.path
     WHERE f.id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number }>).map((row) => row.id));
  if (commits.size === 0) return null;
  const flags = inBatches([...commits], (batch) => db.prepare(
    `SELECT recent, ai FROM history_commits WHERE id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ recent: number; ai: number }>);
  return {
    commits: commits.size,
    recent: flags.reduce((sum, row) => sum + row.recent, 0),
    ai: flags.reduce((sum, row) => sum + row.ai, 0),
  };
}

/** The git history of a file, and the files that are often changed with it. If the history hasn't been read (not in git, or the configuration is turned off), it is null */
export function fileHistory(db: Db, fileId: number): FileHistoryDto | null {
  const file = db.prepare("SELECT path FROM files WHERE id = ?").get(fileId) as { path: string } | undefined;
  if (!file) return null;
  const row = db.prepare(
    "SELECT commits, recent, last_at AS lastAt, authors, ai_commits AS ai FROM file_history WHERE path = ?",
  ).get(file.path) as { commits: number; recent: number; lastAt: string | null; authors: number; ai: number } | undefined;
  if (!row) return null;

  const partners = db.prepare(
    `SELECT CASE WHEN a = ? THEN b ELSE a END AS path, together FROM co_changes
     WHERE a = ? OR b = ? ORDER BY together DESC LIMIT ?`,
  ).all(file.path, file.path, file.path, CO_CHANGED_LISTED) as Array<{ path: string; together: number }>;
  const idOf = db.prepare("SELECT id FROM files WHERE path = ?");
  const neighbors = (id: number) => new Set((db.prepare(
    `SELECT dst_id AS other FROM edges WHERE src_kind = 'file' AND dst_kind = 'file' AND type IN ('imports', 'references', 'http') AND src_id = ?
     UNION SELECT src_id AS other FROM edges WHERE src_kind = 'file' AND dst_kind = 'file' AND type IN ('imports', 'references', 'http') AND dst_id = ?`,
  ).all(id, id) as Array<{ other: number }>).map((r) => r.other));
  const mine = neighbors(fileId);

  return {
    commits: row.commits,
    recentCommits: row.recent,
    lastChangedAt: row.lastAt,
    authors: row.authors,
    aiCommits: row.ai,
    coChanged: partners.map((partner) => {
      const id = (idOf.get(partner.path) as { id: number } | undefined)?.id ?? null;
      const theirs = id === null ? new Set<number>() : neighbors(id);
      // Direct dependency, or being connected through the same file, both count as having a relationship in the code.
      const linked = id !== null && (mine.has(id) || [...mine].some((x) => theirs.has(x)));
      return { id: id === null ? null : `file:${id}`, path: partner.path, together: partner.together, linked };
    }),
  };
}
