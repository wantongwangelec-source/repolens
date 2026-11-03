import type { ConfirmedLayer, FindingSummaryDto, OverviewDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Chip, LinkButton, Section } from "../ui/panel";

/**
 * Agreement: The hierarchy proposed by AI will be written into .repolens.json after human confirmation, and from then on, 'lower layers depend on upper layers' is a health check issue;
 * Dependency locks record the current inter-module dependencies as an approved list, and newly introduced dependencies must be approved first. Both files are submitted with the code.
 */
export function ConventionsSection({ overview }: { overview: OverviewDto }) {
  const t = useT();
  const indexRevision = useAppStore((s) => s.indexRevision);
  const setPanelTab = useAppStore((s) => s.setPanelTab);
  const setTreeOpen = useAppStore((s) => s.setTreeOpen);
  const [summary, setSummary] = useState<FindingSummaryDto | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"lock" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.findings().then((result) => !cancelled && setSummary(result.summary)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [indexRevision]);

  const layers = overview.layers ?? [];
  const unapproved = summary?.byKind["unapproved"] ?? 0;
  const layering = summary?.byKind["layering"] ?? 0;
  const violations = summary?.byKind["violation"] ?? 0;

  const writeLock = () => {
    setBusy("lock");
    setError(null);
    void api.writeLock()
      .then(() => useAppStore.getState().refreshIndex())
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  const showFindings = () => {
    setPanelTab("findings");
    setTreeOpen(true);
  };

  return (
    <Section title={t("约定")}>
      <div className="space-y-2.5">
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-[var(--color-ink)]">{t("分层")}</span>
            {layers.length === 0 ? (
              <Chip>{t("还没有")}</Chip>
            ) : overview.layersConfirmed ? (
              <Chip tone="success">{t("已确认")}</Chip>
            ) : (
              <Chip tone="accent">{t("AI 提议，未确认")}</Chip>
            )}
            {layering > 0 && <Chip tone="danger">{t("{count} 处倒置", { count: layering })}</Chip>}
            {layers.length > 0 && !editing && (
              <span className="ml-auto">
                <LinkButton onClick={() => setEditing(true)}>{overview.layersConfirmed ? t("调整") : t("确认…")}</LinkButton>
              </span>
            )}
          </div>
          {editing ? (
            <LayerEditor overview={overview} onDone={() => setEditing(false)} />
          ) : layers.length > 0 ? (
            <ol className="mt-1 space-y-0.5">
              {layers.map((layer, index) => (
                <li key={layer.name} className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="w-3 shrink-0 tabular-nums text-[var(--color-ink-faint)]">{index + 1}</span>
                  <span className="shrink-0 text-[var(--color-ink)]">{layer.name}</span>
                  <span className="mono min-w-0 truncate text-[10px] text-[var(--color-ink-faint)]">
                    {layer.nodeIds.map(memberLabel).join(", ")}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {!overview.layersConfirmed && layers.length > 0 && !editing && (
            <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
              {t("确认后写进 .repolens.json：自上而下排好，下层依赖上层就算分层倒置，CI 里的 repolens check 也会拦。")}
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-[var(--color-ink)]">{t("依赖锁")}</span>
            {overview.lock ? (
              <Chip tone="success">{t("{count} 条批准过的依赖", { count: overview.lock.dependencies })}</Chip>
            ) : (
              <Chip>{t("还没有")}</Chip>
            )}
            {unapproved > 0 && (
              <button type="button" onClick={showFindings} className="shrink-0">
                <Chip tone="danger">{t("{count} 条未批准", { count: unapproved })}</Chip>
              </button>
            )}
            <span className="ml-auto">
              <LinkButton onClick={writeLock} disabled={busy !== null}>
                {busy === "lock" ? t("写入中…") : overview.lock ? t("批准现在的依赖") : t("锁定现在的依赖")}
              </LinkButton>
            </span>
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
            {overview.lock
              ? t("锁里没有的模块间依赖会出现在体检里。确认合理再批准：会重写 .repolens.lock.json，批准本身出现在代码评审里。")
              : t("把现在的模块间依赖写进 .repolens.lock.json 并提交。之后 AI 顺手加出来的新依赖都会被体检和 repolens check 拦下。")}
          </p>
        </div>

        {violations > 0 && (
          <button type="button" onClick={showFindings} className="block text-left">
            <Chip tone="danger">{t("{count} 处违反依赖规则", { count: violations })}</Chip>
          </button>
        )}
        {error && <div className="text-[11px] text-[var(--color-warn)]">{error}</div>}
      </div>
    </Section>
  );
}

interface DraftLayer {
  name: string;
  description: string | null;
  members: string[];
}

/** Humans confirm the AI-proposed hierarchy: names can be changed, order adjusted, and members that shouldn't be in this level can be removed. */
function LayerEditor({ overview, onDone }: { overview: OverviewDto; onDone: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<DraftLayer[]>(() =>
    (overview.layers ?? []).map((layer) => ({
      name: layer.name,
      description: layer.description || null,
      members: layer.nodeIds.filter((id) => /^(?:pkg|dir):./.test(id)),
    })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, change: Partial<DraftLayer>) =>
    setDraft((layers) => layers.map((layer, i) => (i === index ? { ...layer, ...change } : layer)));
  const move = (index: number, delta: -1 | 1) =>
    setDraft((layers) => {
      const next = [...layers];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });

  const valid = draft.filter((layer) => layer.name.trim() !== "" && layer.members.length > 0);
  const save = () => {
    setBusy(true);
    setError(null);
    const layers: ConfirmedLayer[] = valid.map((layer) => ({ name: layer.name.trim(), description: layer.description, members: layer.members }));
    void api.confirmLayers(layers)
      .then(() => useAppStore.getState().refreshIndex())
      .then(onDone)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-1.5 space-y-1.5 rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2">
      <p className="text-[10.5px] text-[var(--color-ink-faint)]">{t("自上而下：上层可以依赖下层，反过来算分层倒置")}</p>
      {draft.map((layer, index) => (
        <div key={index} className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] p-1.5">
          <div className="flex items-center gap-1">
            <span className="w-3 shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">{index + 1}</span>
            <input
              value={layer.name}
              onChange={(event) => update(index, { name: event.target.value })}
              aria-label={t("分层名")}
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-[11.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-line-strong)]"
            />
            <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("上移")} className="px-1 text-[11px] text-[var(--color-ink-faint)] enabled:hover:text-[var(--color-ink)] disabled:opacity-30">↑</button>
            <button type="button" disabled={index === draft.length - 1} onClick={() => move(index, 1)} aria-label={t("下移")} className="px-1 text-[11px] text-[var(--color-ink-faint)] enabled:hover:text-[var(--color-ink)] disabled:opacity-30">↓</button>
          </div>
          <div className="mt-1 flex flex-wrap gap-1 pl-4">
            {layer.members.map((member) => (
              <span key={member} className="mono inline-flex items-center gap-0.5 rounded bg-[var(--color-surface-3)] px-1 text-[10px] text-[var(--color-ink-muted)]">
                {memberLabel(member)}
                <button
                  type="button"
                  onClick={() => update(index, { members: layer.members.filter((m) => m !== member) })}
                  aria-label={t("从这一层移除")}
                  className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)]"
                >
                  ×
                </button>
              </span>
            ))}
            {layer.members.length === 0 && <span className="text-[10px] text-[var(--color-warn)]">{t("没有成员的层不会保存")}</span>}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={busy || valid.length === 0}
          onClick={save}
          className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? t("写入中…") : t("确认，写进 .repolens.json")}
        </button>
        <LinkButton onClick={onDone} tone="muted">{t("取消")}</LinkButton>
      </div>
      {error && <div className="text-[11px] text-[var(--color-warn)]">{error}</div>}
    </div>
  );
}

function memberLabel(id: string): string {
  return id.startsWith("pkg:") ? id.slice(4) : id.replace(/^dir:/, "");
}
