import type { ElkNode } from "elkjs/lib/elk-api";
import type { LayoutRequest, LayoutResponse } from "./elk.worker";

type ElkLike = { layout: (graph: ElkNode) => Promise<ElkNode> };

/**
 * Layout engine.
 *
 * Prefer Worker (move CPU-intensive layouts off the main thread), but Worker in some bundlers/browsers
 * It won't rise when combined. Layout failure means the whole picture degenerates into a pile of blocks overlapping at the origin——
 * This failure mode is too serious, the main thread must have a safeguard.
 */
export class LayoutEngine {
  private worker: Worker | null = null;
  private workerBroken = false;
  private mainThreadElk: Promise<ElkLike> | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (graph: ElkNode) => void; reject: (err: Error) => void }
  >();

  async layout(graph: ElkNode): Promise<ElkNode> {
    if (!this.workerBroken) {
      try {
        return await this.layoutInWorker(graph);
      } catch {
        this.workerBroken = true;
        this.disposeWorker();
      }
    }
    const elk = await this.getMainThreadElk();
    return elk.layout(graph);
  }

  dispose(): void {
    this.disposeWorker();
    for (const entry of this.pending.values()) entry.reject(new Error("布局引擎已释放"));
    this.pending.clear();
  }

  private layoutInWorker(graph: ElkNode): Promise<ElkNode> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const request: LayoutRequest = { id, graph };

    return new Promise<ElkNode>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL("./elk.worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      if (event.data.graph) entry.resolve(event.data.graph);
      else entry.reject(new Error(event.data.error ?? "布局失败"));
    };

    worker.onerror = () => {
      for (const entry of this.pending.values()) entry.reject(new Error("布局 Worker 崩溃"));
      this.pending.clear();
    };

    this.worker = worker;
    return worker;
  }

  private disposeWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private getMainThreadElk(): Promise<ElkLike> {
    this.mainThreadElk ??= import("elkjs/lib/elk.bundled.js").then((mod) => {
      const Ctor = resolveElkConstructor(mod);
      return new Ctor() as ElkLike;
    });
    return this.mainThreadElk;
  }
}

/**
 * elkjs is a UMD package built with browserify, and different bundlers provide different ESM interop shapes:
 * It could be the function itself, or `{ default: function }`, or even wrapped one more layer. Peel it layer by layer until it can be used with new.
 */
export function resolveElkConstructor(mod: unknown): new (options?: unknown) => unknown {
  let candidate: unknown = mod;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof candidate === "function") {
      return candidate as new (options?: unknown) => unknown;
    }
    if (candidate && typeof candidate === "object" && "default" in candidate) {
      candidate = (candidate as { default: unknown }).default;
      continue;
    }
    break;
  }
  throw new Error("无法从 elkjs 模块中取到构造函数");
}
