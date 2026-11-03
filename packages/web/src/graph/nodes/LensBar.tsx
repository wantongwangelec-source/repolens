import type { GraphNodeDto } from "@repolens/core/types";
import { useT } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import { useLensStore } from "../../store/useLensStore";
import { ratioWidth } from "../../ui/panel";

/**
 * Perspective overlay layer: a thin strip at the bottom edge of the node. 'Test coverage' shows how much has been tested, 'change heat' is based on the number of commits in the past 90 days.
 * Draw lengths relative to the hottest nodes. The bars only express proportions; specific numbers are placed in the title, with no text on the chart.
 */
export function LensBar({ dto, container = false }: { dto: GraphNodeDto; container?: boolean }) {
  const t = useT();
  const kind = useAppStore((s) => s.lens);
  const value = useLensStore((s) => s.values[dto.id]);
  const maxRecent = useLensStore((s) => s.maxRecent);
  if (kind === null || !value) return null;

  const position = container
    ? "absolute left-3 right-3 top-0 h-[3px] rounded-b"
    : "absolute bottom-0 left-[3px] right-0 h-[3px]";

  if (kind === "heat") {
    const recent = value.recent ?? 0;
    if ((value.commits ?? 0) === 0) return null;
    const share = maxRecent > 0 ? recent / maxRecent : 0;
    return (
      <span
        className={`${position} overflow-hidden bg-[var(--color-surface-3)]`}
        title={t("近 90 天 {recent} 次提交 · 近一年 {commits} 次 · AI 参与 {ai} 次", {
          recent, commits: value.commits ?? 0, ai: value.aiCommits ?? 0,
        })}
      >
        <span className="block h-full" style={{ width: `${Math.max(share * 100, recent > 0 ? 6 : 0)}%`, background: heatColor(share) }} />
      </span>
    );
  }

  const total = value.total ?? 0;
  if (total === 0) return null;
  const covered = value.covered ?? 0;
  return (
    <span className={`${position} flex overflow-hidden bg-[var(--color-surface-3)]`} title={t("测试走到 {covered}/{total} 个函数", { covered, total })}>
      <span style={{ width: ratioWidth(covered, total), background: "var(--color-accent)" }} />
    </span>
  );
}

/** The hotter it gets, the redder it becomes: cold areas are almost uncolored, to avoid the entire image being filled with warning colors. */
function heatColor(share: number): string {
  const mix = Math.round(35 + share * 65);
  return `color-mix(in srgb, var(--color-danger) ${mix}%, var(--color-warn))`;
}
