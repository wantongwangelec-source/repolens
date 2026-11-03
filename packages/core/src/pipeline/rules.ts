import picomatch from "picomatch";
import type { Db } from "../db/database.js";
import type { ArchitectureRule } from "../types.js";

export interface RuleViolation {
  fileId: number;
  filePath: string;
  line: number;
  /** Path within the repository (file or Go package directory) or external package name */
  target: string;
  targetFileId: number | null;
  typeOnly: boolean;
}

export interface RuleReport {
  rule: ArchitectureRule;
  label: string;
  /** Number of source files in the project; if it's 0, it's mostly because the glob is written incorrectly, meaning the rule didn't take effect. */
  checkedFiles: number;
  violations: RuleViolation[];
}

interface ImportRow {
  fileId: number;
  filePath: string;
  line: number;
  typeOnly: number;
  targetFileId: number | null;
  targetPath: string | null;
  targetDir: string | null;
  externalName: string | null;
}

/**
 * Check imports one by one according to the dependency restrictions declared by the repository.
 *
 * Rules are the intentions written by people; the criteria themselves do not give false positives. The only thing that can go wrong is import parsing, so just look at that.
 * Parsed imports for determining targets: files, Go package directories, external package names; unparsed ones are not counted.
 * Test and other non-source code files are not constrained — it is normal for tests to reference the objects being tested across layers.
 */
export function evaluateRules(db: Db, rules: readonly ArchitectureRule[]): RuleReport[] {
  if (rules.length === 0) return [];
  const sources = (db.prepare("SELECT path FROM files WHERE role = 'source'").all() as Array<{ path: string }>)
    .map((row) => row.path);
  const imports = db
    .prepare(
      `SELECT i.file_id AS fileId, sf.path AS filePath, i.line, i.is_type_only AS typeOnly,
              i.target_file_id AS targetFileId, tf.path AS targetPath,
              i.target_dir AS targetDir, i.external_name AS externalName
       FROM imports i
       JOIN files sf ON sf.id = i.file_id
       LEFT JOIN files tf ON tf.id = i.target_file_id
       WHERE sf.role = 'source' AND i.confidence IN ('exact', 'external')
       ORDER BY sf.path, i.line`,
    )
    .all() as ImportRow[];

  return rules.map((rule) => {
    const from = picomatch(rule.from, { dot: true });
    const disallowed = picomatch(rule.disallow, { dot: true });
    const allowed = rule.allow.length > 0 ? picomatch(rule.allow, { dot: true }) : () => false;

    const violations: RuleViolation[] = [];
    for (const row of imports) {
      if (row.typeOnly === 1 && !rule.includeTypeOnly) continue;
      if (!from(row.filePath)) continue;
      const target = row.targetPath ?? row.targetDir ?? row.externalName;
      if (target === null) continue;
      // Go's package-level import falls on the directory, and this kind of notation `internal/db/**` should be able to cover the directory itself
      const probes = row.targetPath === null && row.targetDir !== null ? [target, `${target}/_`] : [target];
      if (!probes.some((probe) => disallowed(probe)) || probes.some((probe) => allowed(probe))) continue;
      violations.push({
        fileId: row.fileId,
        filePath: row.filePath,
        line: row.line,
        target,
        targetFileId: row.targetFileId,
        typeOnly: row.typeOnly === 1,
      });
    }

    return {
      rule,
      label: rule.name ?? `${rule.from.join(", ")} ↛ ${rule.disallow.join(", ")}`,
      checkedFiles: sources.filter((path) => from(path)).length,
      violations,
    };
  });
}
