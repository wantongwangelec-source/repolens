import { loadConfig, loadLock } from "./config.js";
import { unapprovedDependencies, type ModuleDependency } from "./db/architecture.js";
import { indexPath, openDb } from "./db/database.js";
import { buildChangeReport } from "./diff/report.js";
import { evaluateRules, type RuleReport } from "./pipeline/rules.js";
import { scanRepo, type ScanOptions } from "./pipeline/scan.js";
import type { ArchitectureLock, FindingChangeDto, RatchetKind } from "./types.js";

export interface CheckOptions {
  /** Compared to which submission: Only do a ratchet check after it's given */
  baseline?: string | undefined;
  onProgress?: ScanOptions["onProgress"];
}

export interface CheckReport {
  rules: RuleReport[];
  lock: { level: ArchitectureLock["level"]; dependencies: number } | null;
  /** Inter-module dependencies that are not in the dependency lock */
  unapproved: ModuleDependency[];
  /** New issues relative to the baseline: divided according to the ratchet agreed, those that are blocked and those that are only prompted */
  ratchet: { base: { ref: string; commit: string }; failed: FindingChangeDto[]; warned: FindingChangeDto[] } | null;
  passed: boolean;
}

/**
 * All scheduled inspections, CLI, CI, and MCP use the same one:
 * 1. Dependency rules (rules in .repolens.json)
 * 2. Dependency lock (.repolens.lock.json): Interdependencies between modules not in the lock must be approved first
 * 3. Ratchet (when a baseline is given): Relative to the baseline, it is not allowed to add the few types of issues blocked in the agreement.
 *
 * First perform an incremental scan that only builds the structure; what is always checked is the code currently in the workspace.
 */
export async function runCheck(root: string, options: CheckOptions = {}): Promise<CheckReport> {
  const config = loadConfig(root);
  const lock = loadLock(root);
  await scanRepo({ root, structureOnly: true, onProgress: options.onProgress });

  const db = openDb(indexPath(root), { readonly: true });
  let rules: RuleReport[];
  let unapproved: ModuleDependency[];
  try {
    rules = evaluateRules(db, config.rules);
    unapproved = lock ? unapprovedDependencies(db, lock) : [];
  } finally {
    db.close();
  }

  let ratchet: CheckReport["ratchet"] = null;
  if (options.baseline) {
    const report = await buildChangeReport(root, { base: options.baseline, onProgress: options.onProgress });
    const added = report.findings.filter((finding) => finding.status === "added");
    const kindOf = (finding: FindingChangeDto) => finding.kind as RatchetKind;
    ratchet = {
      base: report.base,
      failed: added.filter((finding) => config.ratchet.fail.includes(kindOf(finding))),
      warned: added.filter((finding) => config.ratchet.warn.includes(kindOf(finding))),
    };
  }

  const rulesFailed = rules.some((report) => report.violations.length > 0 || report.checkedFiles === 0);
  return {
    rules,
    lock: lock ? { level: lock.level, dependencies: lock.dependencies.length } : null,
    unapproved,
    ratchet,
    passed: !rulesFailed && unapproved.length === 0 && (ratchet?.failed.length ?? 0) === 0,
  };
}
