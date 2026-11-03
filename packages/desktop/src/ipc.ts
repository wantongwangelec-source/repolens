/** IPC channel between the renderer process and the main process */
export const IPC = {
  getLlmSettings: "repolens:get-llm-settings",
  saveLlmSettings: "repolens:save-llm-settings",
  command: "repolens:command",
  fullScreen: "repolens:full-screen",
  setLocale: "repolens:set-locale",
  loadPrefs: "repolens:load-prefs",
  savePref: "repolens:save-pref",
} as const;

/** The main process sends to the service process */
export type ToServer =
  | { type: "start"; accessToken: string; webRoot: string }
  | { type: "picked"; id: number; path: string | null }
  /** Update the environment variables, null means deletion. The newly set API key takes effect through it, no need to restart the service. */
  | { type: "env"; id: number; values: Record<string, string | null> };

/** Service process sent to the main process */
export type FromServer =
  | { type: "ready"; port: number }
  | { type: "failed"; error: string }
  /** The environment variables have taken effect. Messages and HTTP requests go through different channels, and the rendering process must wait until this step before retrieving the status again. */
  | { type: "env-applied"; id: number }
  /** The service process does not have Electron's dialog API; directory selection needs to be handled by the main process. */
  | { type: "pick-directory"; id: number };
