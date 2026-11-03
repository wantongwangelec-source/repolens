import { ACCESS_TOKEN_COOKIE } from "@repolens/server/auth";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopCommand } from "../../web/src/lib/desktop.js";
import { IPC } from "./ipc.js";
import { LocalServer } from "./local-server.js";
import { isLocale, locale, setLocale, tr } from "./locale.js";
import { buildMenu, HOMEPAGE } from "./menu.js";
import {
  keyEnvUpdate,
  parseLlmSettingsInput,
  readLlmSettings,
  readState,
  writeLlmSettings,
  writeState,
  type WindowState,
} from "./settings.js";
import { readShellEnv } from "./shell-env.js";
import { setupUpdater } from "./updater.js";

const APP_DIR = app.getAppPath();
const DEFAULT_SIZE = { width: 1440, height: 900 };
/** If it crashes more than this many times within a minute, it will no longer automatically restart to avoid getting stuck in a reboot loop. */
const MAX_CRASHES_PER_MINUTE = 3;

let mainWindow: BrowserWindow | null = null;
let origin = "";
let injectedKeyEnv: string | null = null;
const crashTimes: number[] = [];

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppLogsPath();
  const logsDir = app.getPath("logs");
  mkdirSync(logsDir, { recursive: true });
  const log = (line: string) => {
    try {
      appendFileSync(join(logsDir, "main.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // The inability to write logs does not affect usage
    }
  };

  const server = new LocalServer({
    entry: join(APP_DIR, "server.js"),
    webRoot: join(APP_DIR, "web"),
    logFile: join(logsDir, "server.log"),
    pickDirectory,
    onCrash: (code) => void recoverServer(code),
  });

  async function connect(): Promise<void> {
    const { name, values } = keyEnvUpdate(null);
    const port = await server.start(values);
    injectedKeyEnv = name;
    origin = `http://127.0.0.1:${port}`;
    // Page same-origin requests automatically carry cookies, and the front-end code does not need to know the existence of the token.
    await session.defaultSession.cookies.set({
      url: origin,
      name: ACCESS_TOKEN_COOKIE,
      value: server.accessToken,
      httpOnly: true,
      sameSite: "strict",
    });
  }

  async function recoverServer(code: number): Promise<void> {
    const now = Date.now();
    crashTimes.push(now);
    while ((crashTimes[0] ?? now) < now - 60_000) crashTimes.shift();
    log(`服务进程意外退出（代码 ${code}）`);
    if (crashTimes.length > MAX_CRASHES_PER_MINUTE) {
      dialog.showErrorBox(
        tr("RepoLens 服务反复退出", "The RepoLens server keeps exiting"),
        tr(`已停止自动重启。日志在：\n${logsDir}`, `Automatic restart has stopped. Logs are in:\n${logsDir}`),
      );
      return;
    }
    try {
      const repo = mainWindow ? repoOf(mainWindow.webContents.getURL()) : undefined;
      await connect();
      if (mainWindow) void mainWindow.loadURL(pageUrl(repo));
    } catch (err) {
      dialog.showErrorBox(
        tr("RepoLens 服务无法重启", "The RepoLens server couldn't restart"),
        `${(err as Error).message}\n\n${tr("日志在：", "Logs are in: ")}${logsDir}`,
      );
    }
  }

  async function pickDirectory(): Promise<string | null> {
    const options: OpenDialogOptions = {
      title: tr("选择要添加到 RepoLens 的代码仓库", "Choose a code repository to add to RepoLens"),
      buttonLabel: tr("添加", "Add"),
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  function pageUrl(repo: string | undefined): string {
    return `${origin}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
  }

  function repoOf(url: string): string | undefined {
    try {
      return new URL(url).searchParams.get("repo") || undefined;
    } catch {
      return undefined;
    }
  }

  /** When the saved location falls on a monitor that has been disconnected, revert to the default size and center it. */
  function initialBounds(saved: WindowState | undefined): Partial<WindowState> {
    if (!saved) return DEFAULT_SIZE;
    const { x, y, width, height } = saved;
    if (x === undefined || y === undefined) return { width, height };
    const visible = screen.getAllDisplays().some(({ workArea: area }) =>
      x < area.x + area.width && x + width > area.x && y < area.y + area.height && y + height > area.y);
    return visible ? { x, y, width, height } : { width, height };
  }

  function createWindow(): BrowserWindow {
    const saved = readState().window;
    const win = new BrowserWindow({
      ...initialBounds(saved),
      // Consistent with the minimum width of the interface, the top bar will not show horizontal scrolling when the window is dragged to the narrowest.
      minWidth: 1024,
      minHeight: 600,
      show: false,
      title: "RepoLens",
      backgroundColor: "#0b0d10",
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
        : { autoHideMenuBar: true }),
      ...(process.platform === "linux" ? { icon: join(APP_DIR, "icon.png") } : {}),
      webPreferences: {
        preload: join(APP_DIR, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    if (saved?.maximized) win.maximize();

    win.once("ready-to-show", () => win.show());
    win.webContents.on("did-finish-load", () => win.webContents.send(IPC.fullScreen, win.isFullScreen()));
    win.on("enter-full-screen", () => win.webContents.send(IPC.fullScreen, true));
    win.on("leave-full-screen", () => win.webContents.send(IPC.fullScreen, false));
    win.on("close", () => {
      const bounds = win.getNormalBounds();
      writeState({
        window: { ...bounds, maximized: win.isMaximized() },
        lastRepo: repoOf(win.webContents.getURL()) ?? readState().lastRepo,
      });
    });
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });

    // The page is only allowed to stay on the local service; external links are handled by the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith(`${origin}/`)) return;
      event.preventDefault();
      openExternal(url);
    });
    // Electron does not have a default right-click menu, at least text input fields and selected text should be able to copy and paste
    win.webContents.on("context-menu", (_event, params) => {
      const items: MenuItemConstructorOptions[] = params.isEditable
        ? [
          { role: "cut", label: tr("剪切", "Cut") },
          { role: "copy", label: tr("复制", "Copy") },
          { role: "paste", label: tr("粘贴", "Paste") },
          { type: "separator" },
          { role: "selectAll", label: tr("全选", "Select All") },
        ]
        : params.selectionText.trim() !== ""
          ? [{ role: "copy", label: tr("复制", "Copy") }]
          : [];
      if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
    });

    void win.loadURL(pageUrl(readState().lastRepo));
    return win;
  }

  function openExternal(url: string): void {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  }

  /** Menu commands are sent to the page; when the window is just closed, it is reopened first, and commands for pages that haven't finished loading are not resent. */
  function sendCommand(command: DesktopCommand): void {
    if (!origin) return;
    if (!mainWindow) {
      mainWindow = createWindow();
      return;
    }
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.command, command);
  }

  function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return origin !== "" && (event.senderFrame?.url ?? "").startsWith(`${origin}/`);
  }

  function assertFromApp(event: IpcMainInvokeEvent): void {
    if (!fromApp(event)) throw new Error(tr("拒绝来自未知页面的请求", "Rejected a request from an unknown page"));
  }

  ipcMain.handle(IPC.getLlmSettings, (event) => {
    assertFromApp(event);
    return readLlmSettings();
  });

  ipcMain.handle(IPC.saveLlmSettings, async (event, input: unknown) => {
    assertFromApp(event);
    writeLlmSettings(parseLlmSettingsInput(input));
    const { name, values } = keyEnvUpdate(injectedKeyEnv);
    injectedKeyEnv = name;
    await server.setEnv(values);
    return readLlmSettings();
  });

  // The page reports once every time it loads; the menu is only rebuilt and recorded when the language actually changes.
  ipcMain.on(IPC.setLocale, (event, value: unknown) => {
    if (!fromApp(event) || !isLocale(value) || value === locale()) return;
    setLocale(value);
    writeState({ locale: value });
    applyMenu();
  });

  // When dragging the sidebar, it reports once per frame, first store it in memory, accumulate for a while before writing to disk, and write the remaining data before exiting.
  let prefs: Record<string, string> | null = null;
  let prefsTimer: NodeJS.Timeout | null = null;
  const currentPrefs = () => (prefs ??= readState().prefs ?? {});
  function flushPrefs(): void {
    if (prefsTimer === null) return;
    clearTimeout(prefsTimer);
    prefsTimer = null;
    writeState({ prefs: currentPrefs() });
  }

  // preload synchronously waits for this return value, and even if rejected, it must give one
  ipcMain.on(IPC.loadPrefs, (event) => {
    event.returnValue = fromApp(event) ? currentPrefs() : {};
  });

  ipcMain.on(IPC.savePref, (event, key: unknown, value: unknown) => {
    if (!fromApp(event) || typeof key !== "string" || !/^repolens[\w:-]{1,80}$/.test(key)) return;
    if (value !== null && (typeof value !== "string" || value.length > 1_000)) return;
    const next = { ...currentPrefs() };
    if (value === null) delete next[key];
    else next[key] = value;
    prefs = next;
    prefsTimer ??= setTimeout(flushPrefs, 500);
  });

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (!mainWindow && origin) mainWindow = createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => server.stop());
  app.on("will-quit", flushPrefs);

  let updater: ReturnType<typeof setupUpdater> | null = null;

  /** The copy in the menu and about panel is generated according to the current language, and is called again after changing the language. */
  function applyMenu(): void {
    app.setAboutPanelOptions({
      applicationName: "RepoLens",
      applicationVersion: app.getVersion(),
      copyright: tr("本地代码仓库理解工具", "Understand local code repositories"),
      website: HOMEPAGE,
    });
    Menu.setApplicationMenu(buildMenu({
      addRepository: () => sendCommand("add-repository"),
      openSettings: () => sendCommand("open-settings"),
      checkForUpdates: () => updater?.checkNow(),
      openLogs: () => void shell.openPath(logsDir),
    }));
  }

  void app.whenReady().then(async () => {
    updater = setupUpdater(() => mainWindow, log);
    const savedLocale = readState().locale;
    if (savedLocale) setLocale(savedLocale);
    applyMenu();

    // The environment is already complete when launched from the terminal; only when launched from the Dock/desktop menu is it necessary to reload the shell configuration.
    const readsShell = process.platform !== "win32" && !process.env["TERM"];
    const shellEnv = readsShell ? readShellEnv() : Promise.resolve(null);

    try {
      await connect();
    } catch (err) {
      log(`服务启动失败：${(err as Error).stack ?? String(err)}`);
      dialog.showErrorBox(
        tr("RepoLens 无法启动", "RepoLens couldn't start"),
        `${(err as Error).message}\n\n${tr("日志在：", "Logs are in: ")}${logsDir}`,
      );
      app.quit();
      return;
    }

    // Reading the shell usually takes one or two seconds, so waiting a moment can prevent the page from first showing 'AI not configured' before switching.
    // The first time you start after installation, if there are many zsh plugins, it may take more than ten seconds, and you can't let the window wait all the time.
    // First open it, then after reading, provide the service process and refresh the page status.
    const applyShellEnv = shellEnv.then(async (imported) => {
      if (!imported) {
        if (readsShell) log("未能读取登录 shell 的环境变量");
        return false;
      }
      Object.assign(process.env, imported);
      // The key saved in the settings takes precedence over the one exported in the shell.
      await server.setEnv({ ...imported, ...keyEnvUpdate(null).values });
      return true;
    });
    const appliedBeforeWindow = await Promise.race([
      applyShellEnv,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    mainWindow = createWindow();
    updater.checkInBackground();
    if (appliedBeforeWindow === null && await applyShellEnv) {
      mainWindow?.webContents.send(IPC.command, "refresh-status" satisfies DesktopCommand);
    }
  });
}
