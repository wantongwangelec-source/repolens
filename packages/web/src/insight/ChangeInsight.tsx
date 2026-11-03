import type { ChangeClusterDto, ChangeReportDto, ClusterReason, SymbolChangeDto } from "@repolens/core/types";
import { useMemo, useState } from "react";
import { msg, useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { ChangeRow, ChangeSection, ChangeTag } from "../ui/change-rows";
import { IO_LABELS } from "../ui/visual";

/** The value must pass through t() during rendering */
const REASON_LABELS: Record<ClusterReason, string> = {
  exported: msg("对外接口"),
  signature: msg("签名变化"),
  io: msg("新 I/O"),
  calls: msg("新调用"),
  complexity: msg("复杂度上升"),
  untested: msg("没测试"),
  entries: msg("走到入口"),
};

/**
 * Change unit: A set of changes connected along call relationships, reviewing one concept at a time. High-risk ones are placed first—
 * If you’ve modified the external interface, started touching new I/O, and haven’t tested it thoroughly, that’s what should be checked first.
 */
export function ClusterSection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const byId = useMemo(() => new Map(report.symbols.flatMap((s) => (s.id ? [[s.id, s] as const] : []))), [report.symbols]);
  if (report.clusters.length <= 1 && (report.clusters[0]?.members.length ?? 0) <= 1) return null;
  return (
    <ChangeSection
      title={t("改动单元")}
      count={report.clusters.length}
      hint={t("沿调用关系把改动归成组：一组就是一件事。风险高的在前")}
    >
      {report.clusters.map((cluster) => <ClusterRow key={cluster.id} cluster={cluster} byId={byId} />)}
    </ChangeSection>
  );
}

function ClusterRow({ cluster, byId }: { cluster: ChangeClusterDto; byId: ReadonlyMap<string, SymbolChangeDto> }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const [open, setOpen] = useState(false);
  const members = cluster.members.map((id) => byId.get(id)).filter((s): s is SymbolChangeDto => s !== undefined);
  const tone = cluster.risk >= 12 ? "danger" : cluster.risk >= 6 ? "warn" : undefined;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={t("风险 {risk}：{count} 处改动", { risk: cluster.risk, count: members.length })}
        className="block w-full py-[3px] pl-3 pr-3 text-left text-[11.5px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
      >
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 shrink-0 text-center text-[9px] text-[var(--color-ink-faint)]">{open ? "▾" : "▸"}</span>
          <span
            className="mono shrink-0 rounded px-1 text-[9.5px] tabular-nums"
            style={{
              color: tone ? `var(--color-${tone})` : "var(--color-ink-faint)",
              background: tone ? `color-mix(in srgb, var(--color-${tone}) 14%, transparent)` : "var(--color-surface-2)",
            }}
          >
            {cluster.risk}
          </span>
          <span className="mono min-w-0 truncate">{cluster.label}</span>
          {members.length > 1 && <span className="shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">+{members.length - 1}</span>}
        </span>
        {cluster.reasons.length > 0 && (
          <span className="mt-0.5 flex flex-wrap gap-1 pl-4">
            {cluster.reasons.map((reason) => (
              <ChangeTag key={reason.kind} tone={reason.kind === "io" || reason.kind === "untested" ? "warn" : undefined}>
                {t(REASON_LABELS[reason.kind])}{reason.count > 1 ? ` ×${reason.count}` : ""}
              </ChangeTag>
            ))}
          </span>
        )}
      </button>
      {open && members.map((symbol) => (
        <ChangeRow
          key={symbol.id ?? `${symbol.path}:${symbol.name}`}
          status={symbol.status}
          indent
          onClick={symbol.id ? () => void reveal(symbol.id as string) : undefined}
          title={`${symbol.path}:${symbol.line}`}
        >
          <span className="mono truncate">{symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name}</span>
          <span className="mono ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{symbol.path.split("/").at(-1)}</span>
        </ChangeRow>
      ))}
    </div>
  );
}

/** Behavior changes: which functions are newly called, which are no longer called, and which types of I/O are now being touched. Changes in line numbers cannot explain these. */
export function BehaviorSection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  return (
    <ChangeSection title={t("行为变化")} count={report.behavior.length} hint={t("新调了谁、开始碰哪类 I/O：比行数更能说明这次改动做了什么")}>
      {report.behavior.map((change) => {
        const added = change.callsAdded.map((call) => (call.external ? `${call.external}.${call.name}` : call.name));
        const removed = change.callsRemoved.map((call) => (call.external ? `${call.external}.${call.name}` : call.name));
        return (
          <ChangeRow
            key={`${change.path}:${change.name}:${change.line}`}
            status={change.status}
            onClick={change.id ? () => void reveal(change.id as string) : undefined}
            title={[
              added.length > 0 ? t("新调 {names}", { names: added.join(", ") }) : "",
              removed.length > 0 ? t("不再调 {names}", { names: removed.join(", ") }) : "",
            ].filter(Boolean).join("\n")}
          >
            <span className="mono shrink-0">{change.name}</span>
            <span className="min-w-0 truncate text-[10px] text-[var(--color-ink-faint)]">
              {added.length > 0 && <>{t("新调")} <span className="mono text-[var(--color-ink-muted)]">{added.slice(0, 3).join(", ")}{added.length > 3 ? "…" : ""}</span></>}
              {added.length > 0 && removed.length > 0 && " · "}
              {removed.length > 0 && <>{t("不再调")} <span className="mono">{removed.slice(0, 2).join(", ")}{removed.length > 2 ? "…" : ""}</span></>}
            </span>
            <span className="ml-auto flex shrink-0 gap-1">
              {change.ioAdded.map((kind) => <ChangeTag key={`+${kind}`} tone="warn">{t("新碰 {io}", { io: t(IO_LABELS[kind]) })}</ChangeTag>)}
              {change.ioRemoved.map((kind) => <ChangeTag key={`-${kind}`}>{t("不再碰 {io}", { io: t(IO_LABELS[kind]) })}</ChangeTag>)}
            </span>
          </ChangeRow>
        );
      })}
    </ChangeSection>
  );
}

/** Changed the logic, but no function can be reached by any tests: regression can only be detected by human inspection */
export function UntestedSection({ symbols }: { symbols: readonly SymbolChangeDto[] }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const untested = symbols.filter((s) =>
    s.id !== null && s.status !== "removed" && s.tests === 0 && (s.kind === "function" || s.kind === "method") &&
    (s.status === "added" || s.shapeChanged));
  return (
    <ChangeSection title={t("改了但没有测试走到")} count={untested.length} hint={t("沿调用关系静态推算：没有任何测试用例走得到这些函数")}>
      {untested.map((symbol) => (
        <ChangeRow
          key={symbol.id as string}
          status={symbol.status}
          onClick={() => void reveal(symbol.id as string)}
          title={`${symbol.path}:${symbol.line}`}
        >
          <span className="mono truncate">{symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name}</span>
          <span className="mono ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{symbol.path.split("/").at(-1)}</span>
        </ChangeRow>
      ))}
    </ChangeSection>
  );
}
