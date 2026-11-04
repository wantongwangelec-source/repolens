import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useT } from "../i18n";
import { desktop, type DesktopBridge, type LlmSettings } from "../lib/desktop";
import { useAppStore } from "../store/useAppStore";

/**
 * AI settings on the desktop.
 *
 * Command-line users rely on configuration files and environment variables; applications started from the Dock or Start menu cannot access the shell.
 * The variables exported inside are useless without an interface to use AI. The service address and model are written into the command line.
 * The shared configuration file has its keys encrypted and stored by the main process using the system keychain, so the web side cannot access the plaintext.
 */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  if (!open || !desktop) return null;
  return <SettingsForm bridge={desktop} onClose={() => setOpen(false)} />;
}

function SettingsForm({ bridge, onClose }: { bridge: DesktopBridge; onClose: () => void }) {
  const t = useT();
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [interactiveModel, setInteractiveModel] = useState("");
  const [requiresKey, setRequiresKey] = useState(true);
  const [webFetch, setWebFetch] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let disposed = false;
    void bridge.getLlmSettings().then((loaded) => {
      if (disposed) return;
      setSettings(loaded);
      setBaseUrl(loaded.baseUrl);
      setModel(loaded.model);
      setInteractiveModel(loaded.interactiveModel ?? "");
      setRequiresKey(loaded.apiKeyEnv !== "");
      setWebFetch(loaded.webFetch);
      requestAnimationFrame(() => firstField.current?.focus());
    }).catch((err: Error) => {
      if (!disposed) setError(err.message);
    });
    return () => {
      disposed = true;
    };
  }, [bridge]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await bridge.saveLlmSettings({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        interactiveModel: interactiveModel.trim() || null,
        requiresKey,
        webFetch,
        apiKey: apiKey.trim() || (clearKey ? null : undefined),
      });
      await useAppStore.getState().refreshOverview().catch(() => {
        // Settings have been saved; the top bar status will refresh the next time the repository is opened
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)]"
      onClick={onClose}
    >
      <form
        onSubmit={(event) => void save(event)}
        onClick={(event) => event.stopPropagation()}
        className="w-[480px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl"
      >
        <div className="flex items-center border-b border-[var(--color-line)] px-4 py-2.5">
          <span className="text-[13px] font-medium">{t("AI 设置")}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            aria-label={t("关闭")}
          >
            ×
          </button>
        </div>

        {settings === null ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--color-ink-faint)]">
            {error ?? t("正在读取设置…")}
          </div>
        ) : (
          <div className="flex flex-col gap-3.5 p-4">
            <p className="text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
              {t("兼容 OpenAI Chat Completions 接口的服务都可以用：OpenAI、DeepSeek、各类模型网关，或者本机的 Ollama（http://localhost:11434/v1，无需密钥）。")}
            </p>

            <Field label={t("服务地址")}>
              <input
                ref={firstField}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
                className={INPUT}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("模型")} hint={t("生成摘要、伪代码")}>
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="gpt-4o-mini"
                  spellCheck={false}
                  className={INPUT}
                />
              </Field>
              <Field label={t("交互模型")} hint={t("可选，追问时优先使用")}>
                <input
                  value={interactiveModel}
                  onChange={(event) => setInteractiveModel(event.target.value)}
                  placeholder={t("与模型相同")}
                  spellCheck={false}
                  className={INPUT}
                />
              </Field>
            </div>

            <Field label="API Key">
              <label className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
                <input
                  type="checkbox"
                  checked={!requiresKey}
                  onChange={(event) => setRequiresKey(!event.target.checked)}
                />
                {t("这个服务不需要密钥")}
              </label>
              {requiresKey && (
                <KeyInput
                  settings={settings}
                  serviceChanged={serviceOf(baseUrl) !== serviceOf(settings.baseUrl)}
                  value={apiKey}
                  onChange={setApiKey}
                  clearing={clearKey}
                  onToggleClear={() => setClearKey(!clearKey)}
                />
              )}
            </Field>

            <Field label={t("追问")} hint={t("AI 会按需读仓库文件、搜代码、看 git 历史")}>
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
                <input type="checkbox" checked={webFetch} onChange={(event) => setWebFetch(event.target.checked)} />
                {t("允许 AI 抓取公开网页（查依赖库文档、issue 等），不会访问本机和内网地址")}
              </label>
            </Field>

            {error && (
              <div
                className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-2.5 py-2 text-[11px] leading-relaxed text-[var(--color-danger)]"
                role="alert"
              >
                {error}
              </div>
            )}

            <p className="border-t border-[var(--color-line)] pt-2.5 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
              {t("服务地址和模型保存在")} <span className="mono break-all">{settings.configPath}</span>
              {t("，与命令行共用。Key 由系统钥匙串加密后只保存在本机。")}
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-[11.5px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)]"
              >
                {t("取消")}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {saving ? t("正在保存…") : t("保存")}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

const INPUT =
  "mono w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-ink)] outline-none transition-colors placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] disabled:opacity-50";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11.5px] font-medium">{label}</span>
        {hint && <span className="text-[10px] text-[var(--color-ink-faint)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Consistent with the main process's judgment: if the domain name, protocol, or port changes, it is another service, and the original key cannot be reused. */
function serviceOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).origin;
  } catch {
    return null;
  }
}

function KeyInput({
  settings,
  serviceChanged,
  value,
  onChange,
  clearing,
  onToggleClear,
}: {
  settings: LlmSettings;
  serviceChanged: boolean;
  value: string;
  onChange: (value: string) => void;
  clearing: boolean;
  onToggleClear: () => void;
}) {
  const t = useT();
  const envName = serviceChanged
    ? settings.newServiceKeyEnv
    : settings.apiKeyEnv || settings.newServiceKeyEnv;

  if (!settings.canSaveKey) {
    return (
      <p className="text-[11px] leading-relaxed text-[var(--color-warn)]">
        {t("系统钥匙串不可用，无法在这里保存 Key。请在启动 RepoLens 的环境里设置环境变量")}
        <span className="mono"> {envName}</span>
        {!serviceChanged && settings.envKeyPresent ? t("（当前已读取到）") : ""}{t("。")}
      </p>
    );
  }

  const placeholder = serviceChanged
    ? t("填写这个服务的 API Key")
    : clearing
      ? t("保存后清除已保存的 Key")
      : settings.hasSavedKey
        ? t("已保存，留空保持不变")
        : settings.envKeyPresent
          ? t("已从环境变量 {env} 读取，填写后改用这里的", { env: envName })
          : t("粘贴 API Key");

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          disabled={clearing && !serviceChanged}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className={INPUT}
        />
        {settings.hasSavedKey && !serviceChanged && (
          <button
            type="button"
            onClick={onToggleClear}
            className="shrink-0 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-danger)]"
          >
            {clearing ? t("撤销") : t("清除")}
          </button>
        )}
      </div>
      {serviceChanged && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
          {t("换了服务地址，原来的 Key 不会发给新地址。")}
        </p>
      )}
    </div>
  );
}
