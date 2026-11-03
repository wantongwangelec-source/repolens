import { app, dialog, shell, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { tr } from "./locale.js";
import { HOMEPAGE } from "./menu.js";

/** Unsigned macOS apps cannot install automatic updates (Squirrel.Mac will verify the signature) and can only prompt the user to download it. */
const CAN_INSTALL = process.platform !== "darwin";

/**
 * Check for new versions from GitHub Releases.
 *
 * After starting, silently check once in the background, and if it fails, do not disturb; the "Check for Updates…" in the menu will
 * The results (including 'already up to date' and errors) are all communicated to the user through dialog boxes.
 */
export function setupUpdater(getWindow: () => BrowserWindow | null, log: (line: string) => void) {
  autoUpdater.autoDownload = CAN_INSTALL;
  autoUpdater.logger = {
    info: (message?: unknown) => log(`[updater] ${String(message)}`),
    warn: (message?: unknown) => log(`[updater] ${String(message)}`),
    error: (message?: unknown) => log(`[updater] ${String(message)}`),
  };

  let manual = false;
  const show = (options: Electron.MessageBoxOptions) => {
    const win = getWindow();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };

  autoUpdater.on("update-available", (info) => {
    if (CAN_INSTALL) {
      if (manual) {
        void show({
          type: "info",
          message: tr(`发现新版本 ${info.version}`, `Version ${info.version} is available`),
          detail: tr("正在后台下载，完成后会提示你重启安装。", "Downloading in the background. You'll be asked to restart when it's ready."),
        });
      }
      manual = false;
      return;
    }
    manual = false;
    void show({
      type: "info",
      message: tr(`发现新版本 ${info.version}`, `Version ${info.version} is available`),
      detail: tr("前往下载页面获取安装包。", "Get the installer from the download page."),
      buttons: [tr("前往下载", "Download"), tr("稍后", "Later")],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) void shell.openExternal(`${HOMEPAGE}/releases/tag/v${info.version}`);
    });
  });

  autoUpdater.on("update-not-available", () => {
    if (manual) {
      void show({
        type: "info",
        message: tr("已是最新版本", "You're up to date"),
        detail: tr(`当前版本 ${app.getVersion()}`, `Current version ${app.getVersion()}`),
      });
    }
    manual = false;
  });

  autoUpdater.on("update-downloaded", (info) => {
    void show({
      type: "info",
      message: tr(`新版本 ${info.version} 已下载`, `Version ${info.version} has been downloaded`),
      detail: tr("重启 RepoLens 完成安装。", "Restart RepoLens to finish installing."),
      buttons: [tr("立即重启", "Restart Now"), tr("稍后", "Later")],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      // Silent installation and automatic restart; when not silent, Windows will re-launch the full installation wizard
      if (response === 0) autoUpdater.quitAndInstall(true, true);
    });
  });

  autoUpdater.on("error", (err) => {
    log(`[updater] ${err.stack ?? err.message}`);
    if (manual) void show({ type: "warning", message: tr("检查更新失败", "Couldn't check for updates"), detail: err.message });
    manual = false;
  });

  return {
    checkInBackground() {
      if (!app.isPackaged) return;
      setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 10_000);
    },
    checkNow() {
      if (!app.isPackaged) {
        void show({ type: "info", message: tr("开发版本不检查更新", "Development builds don't check for updates") });
        return;
      }
      manual = true;
      void autoUpdater.checkForUpdates().catch(() => {});
    },
  };
}
