import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CANCELLED = "__REPOLENS_DIRECTORY_PICKER_CANCELLED__";

export class DirectoryPickerUnavailableError extends Error {}

/**
 * Open the operating system directory selector instead of letting the browser submit an arbitrary path.
 *
 * The browser's directory input does not expose the native absolute path of the directory, so it cannot be handed over to the scanner;
 * Accepting absolute paths from the frontend would also compromise the security boundaries of the RepoPool. Therefore, it is only listened to locally
 * The Node service directly invokes the system selector and only trusts the directories returned by the system selector.
 */
export async function pickDirectory(): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new DirectoryPickerUnavailableError(
      "当前可视化目录选择仅支持 macOS；请先运行 `repolens scan <路径>`",
    );
  }

  const script = [
    "try",
    '  POSIX path of (choose folder with prompt "选择要添加到 RepoLens 的代码仓库")',
    "on error number -128",
    `  return "${CANCELLED}"`,
    "end try",
  ].join("\n");

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const selected = stdout.trim();
    return selected === CANCELLED || selected.length === 0 ? null : selected;
  } catch (err) {
    throw new DirectoryPickerUnavailableError(
      `无法打开系统目录选择器：${(err as Error).message}`,
    );
  }
}
