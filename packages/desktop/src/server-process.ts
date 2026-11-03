import type { ParentPort } from "electron";
import { startServer } from "@repolens/server";
import type { FromServer, ToServer } from "./ipc.js";

/**
 * A local service running in the Electron utilityProcess.
 *
 * It is the same service as the command-line `repolens serve`, the only difference is the startup parameters: the repository to start is not specified.
 * (All warehouses come from the inventory list), ports are assigned by the system, and each /api request must carry the token issued by the main process.
 * Directory selection is handed over to the main process to pop up a native dialog. Placed in an independent process, scanning and SQLite queries are repeated even more
 * It won't freeze the window.
 */
const port = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort;
const pendingPicks = new Map<number, (path: string | null) => void>();
let nextPickId = 1;

function send(message: FromServer): void {
  port.postMessage(message);
}

function pickDirectory(): Promise<string | null> {
  return new Promise((resolve) => {
    const id = nextPickId++;
    pendingPicks.set(id, resolve);
    send({ type: "pick-directory", id });
  });
}

async function start(accessToken: string, webRoot: string): Promise<void> {
  try {
    const server = await startServer({ repoRoot: null, port: 0, webRoot, accessToken, pickDirectory });
    send({ type: "ready", port: server.port });
  } catch (err) {
    send({ type: "failed", error: (err as Error).message });
  }
}

port.on("message", ({ data }: { data: ToServer }) => {
  if (data.type === "start") {
    void start(data.accessToken, data.webRoot);
  } else if (data.type === "picked") {
    pendingPicks.get(data.id)?.(data.path);
    pendingPicks.delete(data.id);
  } else if (data.type === "env") {
    for (const [name, value] of Object.entries(data.values)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    send({ type: "env-applied", id: data.id });
  }
});
