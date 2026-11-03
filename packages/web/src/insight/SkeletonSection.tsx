import type { DataTableDto, SkeletonDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Chip, RowButton, Section } from "../ui/panel";

/**
 * The skeleton of the system: the types most referenced by function signatures, and the data tables read and written in SQL. First, understand these few things,
 * Reading the function again will tell you what they are carrying.
 */
export function SkeletonSection() {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [skeleton, setSkeleton] = useState<SkeletonDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.skeleton().then((result) => !cancelled && setSkeleton(result)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [indexRevision]);

  if (!skeleton || (skeleton.types.length === 0 && skeleton.tables.length === 0)) return null;

  return (
    <>
      {skeleton.types.length > 0 && (
        <Section title={t("核心数据结构")}>
          <div className="space-y-0.5">
            {skeleton.types.slice(0, 10).map((type) => (
              <RowButton
                key={type.id}
                onClick={() => select(type.id)}
                title={`${type.path}:${type.line}`}
                meta={t("{count} 个函数用到", { count: type.uses })}
              >
                <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">{type.name}</span>
                <span className="text-[10px] text-[var(--color-ink-faint)]">{type.kind}</span>
              </RowButton>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] text-[var(--color-ink-faint)]">
            {t("按在函数签名里出现的次数排：参数和返回值里总是它，它就是系统在搬运的东西")}
          </p>
        </Section>
      )}
      {skeleton.tables.length > 0 && (
        <Section title={t("数据表 ({count})", { count: skeleton.tables.length })}>
          <div className="space-y-0.5">
            {skeleton.tables.map((table) => <TableRow key={table.name} table={table} />)}
          </div>
        </Section>
      )}
    </>
  );
}

function TableRow({ table }: { table: DataTableDto }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <RowButton onClick={() => setOpen(!open)} meta={t("读 {reads} · 写 {writes}", { reads: table.reads.length, writes: table.writes.length })}>
        <span className="text-[10px] text-[var(--color-ink-faint)]">{open ? "▾" : "▸"}</span>
        <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">{table.name}</span>
      </RowButton>
      {open && (
        <div className="ml-3 border-l border-[var(--color-line)] pl-2">
          {[...table.writes.map((ref) => ({ ref, write: true })), ...table.reads.map((ref) => ({ ref, write: false }))].map(({ ref, write }) => (
            <RowButton
              key={`${write ? "w" : "r"}:${ref.symbolId ?? ref.name}:${ref.line}`}
              onClick={ref.symbolId ? () => select(ref.symbolId!) : undefined}
              meta={`${ref.path.split("/").at(-1)}:${ref.line}`}
            >
              <Chip tone={write ? "warn" : "neutral"}>{write ? t("写") : t("读")}</Chip>
              <span className="mono truncate text-[11px] text-[var(--color-ink-muted)]">{ref.name}</span>
            </RowButton>
          ))}
        </div>
      )}
    </div>
  );
}
