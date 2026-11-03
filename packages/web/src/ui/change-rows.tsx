import type { ReactNode } from "react";

/** The markers at the beginning of each line on the change page: Added, Deleted, Modified, Moved, Affected, Eliminated */
export const MARK = { added: "+", removed: "−", modified: "~", moved: "›", affected: "~", resolved: "✓" } as const;
export const MARK_COLOR = {
  added: "var(--color-success)",
  removed: "var(--color-danger)",
  modified: "var(--color-accent)",
  moved: "var(--color-ink-muted)",
  affected: "var(--color-warn)",
  resolved: "var(--color-success)",
} as const;

export function ChangeSection({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mt-3">
      <div className="flex items-center px-3 pb-1 text-[10.5px] font-medium text-[var(--color-ink-muted)]" title={hint}>
        {title}
        <span className="ml-auto tabular-nums text-[var(--color-ink-faint)]">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function ChangeRow({
  status, onClick, title, indent, children,
}: {
  status: keyof typeof MARK;
  onClick?: (() => void) | undefined;
  title?: string | undefined;
  indent?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title}
      className="flex w-full items-center gap-1.5 py-[3px] pr-3 text-left text-[11.5px] text-[var(--color-ink)] enabled:hover:bg-[var(--color-surface-raised)] disabled:cursor-default"
      style={{ paddingLeft: indent ? 26 : 12 }}
    >
      <span className="mono w-2.5 shrink-0 text-center text-[11px]" style={{ color: MARK_COLOR[status] }}>{MARK[status]}</span>
      {children}
    </button>
  );
}

export function ChangeTag({ children, tone }: { children: ReactNode; tone?: "warn" | "danger" }) {
  return (
    <span
      className="shrink-0 rounded px-1 text-[9px]"
      style={{
        color: tone ? `var(--color-${tone})` : "var(--color-ink-faint)",
        background: "var(--color-surface-2)",
      }}
    >
      {children}
    </span>
  );
}

export function ChangeHint({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <div
      className="px-3 py-3 text-[11px] leading-relaxed"
      style={{ color: tone === "danger" ? "var(--color-danger)" : "var(--color-ink-faint)" }}
    >
      {children}
    </div>
  );
}
