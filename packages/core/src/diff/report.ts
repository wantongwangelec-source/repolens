import { existsSync } from "node:fs";
import { indexPath, isIndexCurrent, openDb } from "../db/database.js";
import type { ScanOptions } from "../pipeline/scan.js";
import type { ChangeReportDto } from "../types.js";
import { BaselineError, buildBaseline } from "./baseline.js";
import { diffIndexes } from "./compare.js";

export interface ChangeReportOptions {
  /** Baseline: Any git commit notation (HEAD, main, HEAD~3, sha) */
  base: string;
  /** By default, compare with the current index of the workspace (the caller is responsible for scanning first) */
  head?: string | undefined;
  onProgress?: ScanOptions["onProgress"];
}

export async function buildChangeReport(root: string, options: ChangeReportOptions): Promise<ChangeReportDto> {
  const base = await buildBaseline(root, options.base, options.onProgress);
  const head = options.head ? await buildBaseline(root, options.head, options.onProgress) : null;
  const headPath = head?.dbPath ?? indexPath(root);
  if (!existsSync(headPath) || !isIndexCurrent(headPath)) {
    throw new BaselineError("当前索引不存在或已过期，先运行一次扫描");
  }

  const baseDb = openDb(base.dbPath, { readonly: true });
  const headDb = openDb(headPath, { readonly: true });
  try {
    return diffIndexes(baseDb, headDb, {
      base: { ref: base.ref, commit: base.commit },
      head: head ? { ref: head.ref, commit: head.commit } : null,
    });
  } finally {
    baseDb.close();
    headDb.close();
  }
}
