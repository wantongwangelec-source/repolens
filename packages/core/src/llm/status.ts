import type { LlmConfig, LlmUsage } from "../types.js";
import { loadConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { readLlmStatus, writeLlmStatus, type StoredLlmStatus } from "../db/semantic.js";
import { emptyUsage, llmUnavailableReason } from "./client.js";

/**
 * Overview shows AI status: switches, models, and credentials are determined according to the current configuration, and cumulative usage is taken from what is recorded in the index.
 *
 * The state stored in the index stops at the moment of the last scan. Only after the scan are the key set, the model changed, or
 * The key entered on the desktop should be immediately reflected on the interface, rather than waiting for the next rescan.
 */
export function currentLlmStatus(db: Db, repoRoot: string): StoredLlmStatus | null {
  const stored = readLlmStatus(db);
  let config: LlmConfig;
  try {
    config = loadConfig(repoRoot).llm;
  } catch (err) {
    // A corrupted configuration file shouldn't bring down the entire overview; the same error will occur when actually calling AI.
    return stored && { ...stored, available: false, reason: (err as Error).message };
  }
  const reason = llmUnavailableReason(config);
  return {
    enabled: config.enabled,
    available: reason === null,
    model: config.model,
    interactiveModel: config.interactiveModel,
    reason,
    usage: stored?.model === config.model ? stored.usage : emptyUsage(),
  };
}

export function mergeLlmStatusUsage(
  db: Db,
  input: Omit<StoredLlmStatus, "usage"> & { usage?: LlmUsage },
): void {
  const previous = readLlmStatus(db);
  // After switching models, recalculate to avoid counting the old model's tokens toward the new model head.
  const usage = previous?.model === input.model ? previous.usage : emptyUsage();
  const add = input.usage ?? emptyUsage();
  writeLlmStatus(db, {
    enabled: input.enabled,
    available: input.available,
    model: input.model,
    interactiveModel: input.interactiveModel ?? previous?.interactiveModel ?? null,
    reason: input.reason ?? null,
    usage: {
      requests: usage.requests + add.requests,
      inputTokens: usage.inputTokens + add.inputTokens,
      outputTokens: usage.outputTokens + add.outputTokens,
      totalTokens: usage.totalTokens + add.totalTokens,
    },
  });
}
