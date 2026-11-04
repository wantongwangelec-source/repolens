import { globalConfigPath, loadGlobalConfig } from "@repolens/core/config";
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LlmSettings, LlmSettingsInput } from "../../web/src/lib/desktop.js";
import { tr, type Locale } from "./locale.js";

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** A state that only belongs to the desktop, stored in the Electron userData directory */
interface DesktopState {
  /** safeStorage encrypted API key, base64 */
  llmApiKey?: string;
  /** Which service does this key belong to (the origin of the service address); if the service address in the configuration changes, it will no longer use it */
  llmApiKeyService?: string;
  /** Repositories viewed when last window was closed */
  lastRepo?: string;
  /** Use the language last used on the interface, and next time it starts, build the menu according to it first */
  locale?: Locale;
  window?: WindowState;
  /** Page preferences (theme, font size, sidebar width…), keys and values are the same as the page's localStorage */
  prefs?: Record<string, string>;
}

function statePath(): string {
  return join(app.getPath("userData"), "state.json");
}

export function readState(): DesktopState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as DesktopState;
  } catch {
    return {};
  }
}

export function writeState(patch: Partial<DesktopState>): void {
  const next = { ...readState(), ...patch };
  for (const key of Object.keys(next) as Array<keyof DesktopState>) {
    if (next[key] === undefined) delete next[key];
  }
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  // Write to a temporary file first and then rename it; even if the power goes out halfway through writing, it won't leave a file that can't be parsed.
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * When there is no Secret Service / KWallet on Linux, Electron will fall back to basic_text.
 * Using a hard-coded password to 'encrypt' is equivalent to plaintext and cannot be considered securely saved.
 */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

/**
 * After switching services on the desktop side, the key should now be read from this variable. The original variable contained the key of the old service.
 * Since the configuration file and command line are shared, using the old variable name will cause the command line to send the old key to the new address.
 */
const NEW_SERVICE_KEY_ENV = "REPOLENS_API_KEY";

/** The same service can share a key if only the path changes (/v1, /v2); if the domain, protocol, or port changes, it is considered a different service. */
function serviceOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function hasKeyFor(state: DesktopState, baseUrl: string): boolean {
  return state.llmApiKey !== undefined && state.llmApiKeyService !== undefined
    && state.llmApiKeyService === serviceOf(baseUrl);
}

/** Only when the service corresponding to the save and the current configuration are the same should the key be handed over. */
export function savedApiKey(baseUrl: string): string | null {
  const state = readState();
  if (!hasKeyFor(state, baseUrl) || !canEncrypt()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(state.llmApiKey!, "base64"));
  } catch {
    // After changing the device or the keychain is reset, it cannot be unlocked and should be treated as if it was never saved.
    return null;
  }
}

export function readLlmSettings(): LlmSettings {
  const llm = loadGlobalConfig().llm;
  const envName = llm.apiKeyEnv.trim();
  return {
    baseUrl: llm.baseUrl,
    model: llm.model,
    interactiveModel: llm.interactiveModel,
    apiKeyEnv: envName,
    newServiceKeyEnv: NEW_SERVICE_KEY_ENV,
    hasSavedKey: hasKeyFor(readState(), llm.baseUrl),
    envKeyPresent: envName !== "" && Boolean(process.env[envName]?.trim()),
    canSaveKey: canEncrypt(),
    configPath: globalConfigPath(),
    webFetch: llm.webFetch,
  };
}

/** Things coming in through IPC cannot be directly trusted for type annotations */
export function parseLlmSettingsInput(value: unknown): LlmSettingsInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof input[key] === "string" ? input[key] as string : "");
  const apiKey = input["apiKey"];
  return {
    baseUrl: text("baseUrl"),
    model: text("model"),
    interactiveModel: typeof input["interactiveModel"] === "string" ? input["interactiveModel"] : null,
    requiresKey: input["requiresKey"] !== false,
    webFetch: input["webFetch"] !== false,
    apiKey: typeof apiKey === "string" || apiKey === null ? apiKey : undefined,
  };
}

/**
 * Service address and model are written into the global configuration shared with the command line; the key is only encrypted and stored in the client-side local state on the desktop.
 *
 * The configuration file may be a JSON that the user has manually written. Only modify these few fields under llm (including whether it can fetch web pages when asking follow-up questions), and keep the rest unchanged.
 * When the file itself cannot be parsed, it should report an error directly, rather than using an empty object to overwrite the user's content.
 *
 * When switching services, the original keys (both the saved ones and those in the environment variables) can no longer be used; new ones must be provided for the new service.
 * Otherwise, the key of the old service will be sent to the new address as is.
 */
export function writeLlmSettings(input: LlmSettingsInput): void {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const service = /^https?:\/\//i.test(baseUrl) ? serviceOf(baseUrl) : null;
  if (service === null) throw new Error(tr("服务地址要以 http:// 或 https:// 开头", "Service URL must start with http:// or https://"));
  const model = input.model.trim();
  if (model === "") throw new Error(tr("请填写模型名称", "Enter a model name"));
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : input.apiKey;
  const newKey = typeof apiKey === "string" && apiKey !== "" ? apiKey : null;
  if (newKey !== null && !canEncrypt()) throw new Error(tr("系统钥匙串不可用，无法保存 Key", "The system keychain is unavailable, so the key can't be saved"));

  const path = globalConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(tr(
        `配置文件 ${path} 不是合法的 JSON，先修正它再保存：${(err as Error).message}`,
        `The config file ${path} isn't valid JSON. Fix it before saving: ${(err as Error).message}`,
      ));
    }
  }
  const previous = loadGlobalConfig().llm;
  const previousEnv = previous.apiKeyEnv.trim();
  const serviceChanged = serviceOf(previous.baseUrl) !== service;
  if (input.requiresKey && serviceChanged && newKey === null && canEncrypt()) {
    throw new Error(tr("请填写新服务的 API Key", "Enter the API key for the new service"));
  }

  const llm = typeof raw["llm"] === "object" && raw["llm"] !== null ? raw["llm"] as Record<string, unknown> : {};
  raw["llm"] = {
    ...llm,
    enabled: true,
    baseUrl,
    model,
    interactiveModel: input.interactiveModel?.trim() || null,
    apiKeyEnv: !input.requiresKey
      ? ""
      : serviceChanged || previousEnv === ""
        ? NEW_SERVICE_KEY_ENV
        : previousEnv,
    webFetch: input.webFetch,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

  if (newKey !== null) {
    writeState({ llmApiKey: safeStorage.encryptString(newKey).toString("base64"), llmApiKeyService: service });
  } else if (apiKey === null || serviceChanged) {
    writeState({ llmApiKey: undefined, llmApiKeyService: undefined });
  }
}

/**
 * The key environment variables that the service process should see.
 *
 * Save the key into the variable name specified in the configuration, overwriting the one inherited from the shell; after clearing, revert back
 * The inherited value. If the variable name is changed (for example, switching to a service that doesn't require a key), the old name should also be restored to its original state.
 */
export function keyEnvUpdate(previousName: string | null): { name: string | null; values: Record<string, string | null> } {
  let name: string | null = null;
  let baseUrl = "";
  try {
    const llm = loadGlobalConfig().llm;
    name = llm.apiKeyEnv.trim() || null;
    baseUrl = llm.baseUrl;
  } catch {
    // The configuration file is corrupted: nothing is injected, and the AI functions will each report configuration errors
  }
  const values: Record<string, string | null> = {};
  if (previousName !== null && previousName !== name) values[previousName] = process.env[previousName] ?? null;
  if (name !== null) values[name] = savedApiKey(baseUrl) ?? process.env[name] ?? null;
  return { name, values };
}
