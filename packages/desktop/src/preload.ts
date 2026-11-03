import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopBridge, DesktopCommand } from "../../web/src/lib/desktop.js";
import { IPC } from "./ipc.js";

/** Errors from ipcRenderer.invoke will carry the prefix 'Error invoking remote method …', but only the original message is displayed on the interface. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    throw new Error(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

/**
 * The local service uses a different port each time it starts, and when the page changes its origin, localStorage is just empty. Page script
 * Before running, restore the preferences saved by the main process; the page still only reads from localStorage as usual. Old keys that are no longer in the preferences.
 * Also clear it: when the port happens to be the same as it was a long time ago, there are still expired values left in localStorage.
 */
function restorePrefs(): void {
  try {
    const prefs = ipcRenderer.sendSync(IPC.loadPrefs) as Record<string, string>;
    // This package type does not include DOM, it only declares the two methods that are used.
    const storage = (globalThis as unknown as {
      localStorage: { setItem(key: string, value: string): void; removeItem(key: string): void };
    }).localStorage;
    for (const key of Object.keys(storage)) {
      if (key.startsWith("repolens") && !(key in prefs)) storage.removeItem(key);
    }
    for (const [key, value] of Object.entries(prefs)) storage.setItem(key, value);
  } catch {
    // If it cannot be read, use the default settings
  }
}

restorePrefs();

const bridge: DesktopBridge = {
  platform: process.platform as DesktopBridge["platform"],
  getLlmSettings: () => invoke(IPC.getLlmSettings),
  saveLlmSettings: (input) => invoke(IPC.saveLlmSettings, input),
  onCommand: (listener) => subscribe<DesktopCommand>(IPC.command, listener),
  onFullScreenChange: (listener) => subscribe<boolean>(IPC.fullScreen, listener),
  setLocale: (locale) => ipcRenderer.send(IPC.setLocale, locale),
  savePref: (key, value) => ipcRenderer.send(IPC.savePref, key, value),
};

contextBridge.exposeInMainWorld("repolensDesktop", bridge);
