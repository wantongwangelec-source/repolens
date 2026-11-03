import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** These variables describe that disposable shell itself and do not belong to user configuration. */
const SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID"]);

/**
 * Read the environment variables in the user's login shell.
 *
 * When launched from the Dock, Finder, or the desktop environment's menu, the application only inherits the streamlined environment of the system session.
 * Cannot read the OPENAI_API_KEY, proxy, and PATH exported in ~/.zshrc. Command line users have long since
 * These that have been configured should not be set up again on the desktop, so use an interactive login shell to run `env -0` and retrieve them.
 * Adding random markers before and after is to strip away noise such as the welcome messages echoed in the rc file.
 *
 * Windows environment variables come from the registry and are provided directly to applications by the system, so this step is not necessary.
 */
export function readShellEnv(timeoutMs = 60_000): Promise<Record<string, string> | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  const shell = process.env["SHELL"] || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const mark = randomUUID();

  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", `printf '%s' '${mark}'; command env -0; printf '%s' '${mark}'`], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      const start = output.indexOf(mark);
      const end = output.lastIndexOf(mark);
      if (start < 0 || end <= start) return resolve(null);

      const env: Record<string, string> = {};
      for (const entry of output.slice(start + mark.length, end).split("\0")) {
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const name = entry.slice(0, eq);
        if (!SKIP.has(name)) env[name] = entry.slice(eq + 1);
      }
      resolve(env);
    });
  });
}
