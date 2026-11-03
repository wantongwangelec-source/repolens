import { scanRepo, type ScanPhase } from "@repolens/core";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerInput {
  root: string;
  /** Only refresh the structure, do not call the model: used for automatic refresh after file changes */
  structureOnly?: boolean;
}

type WorkerMessage =
  | { type: "progress"; phase: ScanPhase; done: number; total: number }
  | { type: "completed" }
  | { type: "failed"; error: string };

const port = parentPort;
if (port === null) throw new Error("扫描 worker 缺少父线程");

const { root, structureOnly } = workerData as WorkerInput;

// No need for top-level await: the desktop version will compile this file into CommonJS
const run = async (): Promise<void> => {
  try {
    await scanRepo({
      root,
      structureOnly: structureOnly ?? false,
      onProgress: (phase, done, total) => {
        port.postMessage({ type: "progress", phase, done, total } satisfies WorkerMessage);
      },
    });
    port.postMessage({ type: "completed" } satisfies WorkerMessage);
  } catch (err) {
    port.postMessage({
      type: "failed",
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerMessage);
  }
};

void run();
