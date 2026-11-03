import { utilityProcess, type UtilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, statSync, truncateSync, type WriteStream } from "node:fs";
import type { FromServer, ToServer } from "./ipc.js";
import { tr } from "./locale.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface LocalServerOptions {
  entry: string;
  webRoot: string;
  logFile: string;
  pickDirectory: () => Promise<string | null>;
  /** Service process exited unexpectedly (not triggered by stop()) */
  onCrash: (code: number) => void;
}

/**
 * Manage the local services running in the utilityProcess.
 *
 * The token is regenerated every time the application starts and remains unchanged throughout the application's lifecycle; after the service crashes and restarts
 * The port will change, the token remains the same, and the window only needs to reload with a different address.
 */
export class LocalServer {
  readonly accessToken = randomBytes(32).toString("hex");
  private child: UtilityProcess | null = null;
  private stopping = false;
  private readonly log: WriteStream;
  private readonly pendingEnv = new Map<number, () => void>();
  private nextEnvId = 1;

  constructor(private readonly options: LocalServerOptions) {
    if (existsSync(options.logFile) && statSync(options.logFile).size > MAX_LOG_BYTES) {
      truncateSync(options.logFile, 0);
    }
    this.log = createWriteStream(options.logFile, { flags: "a" });
  }

  /** @param env Variables overlaid on the current process environment, null means not passed to the service process */
  start(env: Record<string, string | null> = {}): Promise<number> {
    this.stopping = false;
    const childEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries({ ...process.env, ...env })) {
      if (typeof value === "string") childEnv[name] = value;
    }
    const child = utilityProcess.fork(this.options.entry, [], {
      serviceName: "RepoLens Server",
      stdio: "pipe",
      env: childEnv,
    });
    this.child = child;
    this.log.write(`\n=== ${new Date().toISOString()} 启动服务进程 ===\n`);
    child.stdout?.on("data", (chunk: Buffer) => this.log.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.log.write(chunk));

    return new Promise((resolve, reject) => {
      let ready = false;
      child.on("message", (message: FromServer) => {
        if (message.type === "ready") {
          ready = true;
          resolve(message.port);
        } else if (message.type === "failed") {
          reject(new Error(message.error));
        } else if (message.type === "env-applied") {
          this.pendingEnv.get(message.id)?.();
          this.pendingEnv.delete(message.id);
        } else if (message.type === "pick-directory") {
          void this.options.pickDirectory()
            .catch(() => null)
            .then((path) => this.send({ type: "picked", id: message.id, path }));
        }
      });
      child.once("spawn", () => {
        this.send({ type: "start", accessToken: this.accessToken, webRoot: this.options.webRoot });
      });
      child.once("exit", (code) => {
        this.log.write(`=== 服务进程退出，代码 ${code} ===\n`);
        if (this.child === child) this.child = null;
        for (const done of this.pendingEnv.values()) done();
        this.pendingEnv.clear();
        if (!ready) {
          reject(new Error(tr(
            `服务进程启动失败（代码 ${code}），详见日志 ${this.options.logFile}`,
            `The server process failed to start (code ${code}). See the log at ${this.options.logFile}`,
          )));
        } else if (!this.stopping) {
          this.options.onCrash(code);
        }
      });
    });
  }

  /** The service process is only resolved after confirmation of effectiveness; if the process is not running, it is resolved directly, and the next start will include the latest environment. */
  setEnv(values: Record<string, string | null>): Promise<void> {
    if (this.child === null || Object.keys(values).length === 0) return Promise.resolve();
    const id = this.nextEnvId++;
    return new Promise((resolve) => {
      this.pendingEnv.set(id, resolve);
      this.send({ type: "env", id, values });
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }

  private send(message: ToServer): void {
    this.child?.postMessage(message);
  }
}
