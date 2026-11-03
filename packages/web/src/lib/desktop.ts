/**
 * The desktop client through the ability injected by preload.
 *
 * When opened in the browser (command line `repolens open`), it is null, and the entry that depends on it——AI settings,
 * Native menu commands—they all do not appear. The implementations in preload are based on the types here.
 */
export type DesktopPlatform = "darwin" | "win32" | "linux";

/** refresh-status: The environment of the service process has changed (for example, the shell configuration has been read), and the AI status in the top bar needs to be retrieved again */
export type DesktopCommand = "add-repository" | "open-settings" | "refresh-status";

export interface LlmSettings {
  baseUrl: string;
  model: string;
  interactiveModel: string | null;
  /** Leave empty to indicate that the interface does not require a key, such as Ollama on the local machine. */
  apiKeyEnv: string;
  /** After changing the service address, the key is now read from this environment variable, and the old variable contains the key for the old service. */
  newServiceKeyEnv: string;
  /** The client has saved a key for the current service address, encrypted by the system keychain. */
  hasSavedKey: boolean;
  /** When the key is not saved, is there already one in the environment variables (for example, inherited from the shell configuration) */
  envKeyPresent: boolean;
  /** Whether the system can save the key in encrypted form; false if there is no keychain service on Linux */
  canSaveKey: boolean;
  /** The service address and model are written in this file, shared with the command line */
  configPath: string;
  /** Allow the model to access public web pages during follow-up questions */
  webFetch: boolean;
}

export interface LlmSettingsInput {
  baseUrl: string;
  model: string;
  interactiveModel: string | null;
  requiresKey: boolean;
  webFetch: boolean;
  /** Not passing means keeping the original key, null means clearing it */
  apiKey?: string | null;
}

export interface DesktopBridge {
  platform: DesktopPlatform;
  getLlmSettings: () => Promise<LlmSettings>;
  saveLlmSettings: (input: LlmSettingsInput) => Promise<LlmSettings>;
  /** Command triggered by the native menu; returns the unsubscribe function */
  onCommand: (listener: (command: DesktopCommand) => void) => () => void;
  /** When macOS is in full screen, the red, yellow, and green buttons will be hidden, and the top bar no longer needs to allocate space for them. */
  onFullScreenChange: (listener: (fullScreen: boolean) => void) => () => void;
  /** Native menus and dialogs follow the interface language */
  setLocale: (locale: "zh" | "en") => void;
  /** Save a copy of the interface preferences to the main process, see lib/prefs.ts; null means delete */
  savePref: (key: string, value: string | null) => void;
}

export const desktop: DesktopBridge | null =
  (globalThis as { repolensDesktop?: DesktopBridge }).repolensDesktop ?? null;
