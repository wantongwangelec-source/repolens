/// <reference lib="webworker" />
import * as elkModule from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { resolveElkConstructor } from "./engine";

/**
 * Layout Worker.
 *
 * The layered layout of ELK is CPU-intensive, running it on the main thread will cause frames to drop during dragging and zooming—
 * This refers to the computations that the docs/INTERACTION.md 'transfer' strategy explicitly requires to be transferred out.
 */
export interface LayoutRequest {
  id: number;
  graph: ElkNode;
}

export interface LayoutResponse {
  id: number;
  graph?: ElkNode;
  error?: string;
}

const Elk = resolveElkConstructor(elkModule);
const elk = new Elk() as { layout: (graph: ElkNode) => Promise<ElkNode> };

self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const { id, graph } = event.data;
  try {
    const laid = await elk.layout(graph);
    const message: LayoutResponse = { id, graph: laid };
    self.postMessage(message);
  } catch (err) {
    const message: LayoutResponse = { id, error: (err as Error).message };
    self.postMessage(message);
  }
};
