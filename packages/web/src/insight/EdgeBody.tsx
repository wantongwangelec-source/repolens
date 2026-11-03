import type { BoundaryDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useT } from "../i18n";
import { SOURCE_ONLY_ROLES, useAppStore } from "../store/useAppStore";
import { Chip, Empty, LinkButton, Metric, RowButton, Section, Skeleton } from "../ui/panel";
import { edgeSelection } from "../lib/edge";

/**
 * Edge as a contract: What exactly does an arrow on the architecture diagram consist of—what documents from the other party it references, what names are used, and how many times it is called,
 * Is there a way to bypass the package entry point and access the internals directly? When there is no direct dependency between two sides, provide the shortest indirect import chain.
 */
export function EdgeBody({ from, to }: { from: string; to: string }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const openDetail = useAppStore((s) => s.openDetail);
  const showNoise = useAppStore((s) => s.showNoise);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [boundary, setBoundary] = useState<BoundaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBoundary(null);
    setError(null);
    const roles = showNoise ? undefined : SOURCE_ONLY_ROLES.join(",");
    void api.boundary(from, to, roles)
      .then((result) => !cancelled && setBoundary(result))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [from, to, showNoise, indexRevision]);

  if (error) return <Empty>{error}</Empty>;
  if (!boundary) return <Skeleton />;

  const { totals } = boundary;
  const direct = boundary.imports.length > 0 || boundary.http.length > 0;
  // Only HTTP requests, without import edges; the number of files is counted based on the files making the requests
  const files = new Set([...boundary.imports.map((imp) => imp.fromPath), ...boundary.http.map((h) => h.callerPath)]).size;

  return (
    <div className="p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-medium">
        <button type="button" onClick={() => select(boundary.from.id)} className="truncate hover:text-[var(--color-accent)]">
          {boundary.from.label}
        </button>
        <span className="shrink-0 text-[var(--color-ink-faint)]">→</span>
        <button type="button" onClick={() => select(boundary.to.id)} className="truncate hover:text-[var(--color-accent)]">
          {boundary.to.label}
        </button>
        <span className="ml-auto shrink-0">
          <LinkButton onClick={() => select(edgeSelection(to, from))} tone="muted" title={t("看反方向的依赖")}>
            ⇄
          </LinkButton>
        </span>
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
        {t("这条依赖由什么构成。左边用到的名字就是两边之间的契约：改它们的签名，右边要跟着改。")}
      </p>

      {direct ? (
        <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[var(--color-line)] pt-2.5">
          <Metric label={t("文件")} value={String(files)} />
          <Metric label="import" value={String(totals.imports)} />
          <Metric label={t("调用")} value={String(totals.calls)} />
          {boundary.http.length > 0 && totals.bypass === 0
            ? <Metric label="HTTP" value={String(boundary.http.length)} />
            : <Metric label={t("绕过入口")} value={String(totals.bypass)} tone={totals.bypass > 0 ? "warn" : undefined} />}
        </div>
      ) : (
        <Section title={t("没有直接依赖")}>
          {boundary.path && boundary.path.length > 1 ? (
            <>
              <p className="text-[11px] text-[var(--color-ink-muted)]">{t("最短的一条间接 import 链：")}</p>
              <ol className="mt-1 space-y-0.5">
                {boundary.path.map((step, index) => (
                  <li key={step.id}>
                    <RowButton onClick={() => select(step.id)} meta={index === 0 ? undefined : "↓"}>
                      <span className="mono truncate text-[11px] text-[var(--color-ink)]">{step.path}</span>
                    </RowButton>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-[11px] text-[var(--color-ink-faint)]">{t("直接的、间接的都没有：两边在代码里互不相关")}</p>
          )}
        </Section>
      )}

      {boundary.symbols.length > 0 && (
        <Section title={t("用到的名字 ({count})", { count: totals.symbols })}>
          <div className="space-y-0.5">
            {boundary.symbols.map((symbol) => (
              <RowButton
                key={symbol.id}
                onClick={() => select(symbol.id)}
                meta={symbol.importOnly ? t("只 import") : t("{calls} 次 · {callers} 处", { calls: symbol.calls, callers: symbol.callers })}
                title={`${symbol.path}:${symbol.line}`}
              >
                <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">{symbol.name}</span>
                <span className="text-[10px] text-[var(--color-ink-faint)]">{symbol.kind}</span>
              </RowButton>
            ))}
          </div>
        </Section>
      )}

      {boundary.imports.length > 0 && (
        <Section title={`import (${totals.imports})`}>
          <div className="space-y-0.5">
            {boundary.imports.map((imp) => (
              <RowButton
                key={`${imp.fromId}:${imp.line}:${imp.toId}`}
                onClick={() => openDetail(imp.fromId, { tab: "source", lines: [imp.line, imp.line] }, false)}
                title={`${imp.fromPath}:${imp.line} → ${imp.toPath}`}
                meta={`:${imp.line}`}
              >
                <span className="mono min-w-0 truncate text-[11px] text-[var(--color-ink-muted)]">
                  {imp.fromPath.split("/").at(-1)} → {imp.toPath.split("/").at(-1)}
                </span>
                {imp.typeOnly && <Chip>{t("仅类型")}</Chip>}
                {imp.bypass && <Chip tone="warn" title={t("绕过了对方包的入口，直接引了内部文件")}>{t("绕过入口")}</Chip>}
                {imp.names.length > 0 && (
                  <span className="mono min-w-0 truncate text-[10px] text-[var(--color-ink-faint)]">{imp.names.join(", ")}</span>
                )}
              </RowButton>
            ))}
          </div>
        </Section>
      )}

      {boundary.http.length > 0 && (
        <Section title={t("HTTP 请求 ({count})", { count: boundary.http.length })}>
          <div className="space-y-0.5">
            {boundary.http.map((h) => (
              <RowButton
                key={`${h.callerId}:${h.line}:${h.routeId}`}
                onClick={() => select(h.routeId)}
                title={t("前端请求按 URL 对上的后端路由，没有 import 证据")}
                meta={`${h.callerPath.split("/").at(-1)}:${h.line}`}
              >
                <span className="mono truncate text-[11px] text-[var(--color-ink)]">{h.caller}</span>
                <span className="text-[var(--color-ink-faint)]">→</span>
                <span className="mono truncate text-[11px] text-[var(--color-accent)]">{h.route}</span>
              </RowButton>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
