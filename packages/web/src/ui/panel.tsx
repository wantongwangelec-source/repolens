import type { ReactNode } from "react";

export function Label({ children, ai }: { children: ReactNode; ai?: boolean }) {
  return (
    <div
      className="text-[10px] uppercase tracking-wider"
      style={{ color: ai ? "var(--color-accent)" : "var(--color-ink-faint)" }}
    >
      {children}
    </div>
  );
}

export function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" | "danger" }) {
  return (
    <div>
      <div className="text-[10px] text-[var(--color-ink-faint)]">{label}</div>
      <div
        className="mt-0.5 truncate text-[12.5px] tabular-nums"
        style={{ color: tone ? `var(--color-${tone})` : "var(--color-ink)" }}
      >
        {value}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="p-3 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">{children}</div>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3">
      {[...Array(rows)].map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-[var(--color-surface-3)]"
          style={{ width: `${90 - i * 12}%` }}
        />
      ))}
    </div>
  );
}

/** A section in the details: a title line, operations can be placed on the right, and the content is below */
export function Section({
  title,
  aside,
  children,
  ai,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  ai?: boolean;
}) {
  return (
    <section className="mt-3 border-t border-[var(--color-line)] pt-2.5">
      <div className="flex min-h-[18px] items-center gap-2">
        <Label ai={ai}>{title}</Label>
        {aside !== undefined && <div className="ml-auto flex shrink-0 items-center gap-1.5">{aside}</div>}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

export type Tone = "neutral" | "accent" | "warn" | "danger" | "success" | "note";

const CHIP_TONES: Record<Tone, string> = {
  neutral: "border-[var(--color-line)] text-[var(--color-ink-faint)]",
  accent: "border-[var(--color-accent)]/40 text-[var(--color-accent)]",
  warn: "border-[var(--color-warn)]/40 text-[var(--color-warn)]",
  danger: "border-[var(--color-danger)]/40 text-[var(--color-danger)]",
  success: "border-[var(--color-success)]/40 text-[var(--color-success)]",
  note: "border-[var(--color-note)]/40 text-[var(--color-note)]",
};

export function Chip({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded border px-1 text-[9.5px] leading-[15px] ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A clickable row in the list: the left side has the name and tag, the right side has the location */
export function RowButton({
  onClick,
  children,
  meta,
  title,
  muted,
}: {
  onClick?: () => void;
  children: ReactNode;
  meta?: ReactNode;
  title?: string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={onClick === undefined}
      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors enabled:hover:bg-[var(--color-surface-2)] disabled:cursor-default ${
        muted ? "opacity-60" : ""
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {meta !== undefined && (
        <span className="mono ml-auto shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">{meta}</span>
      )}
    </button>
  );
}

/** "'How much in how much': for example, measuring to a certain degree" */
export function RatioBar({
  value,
  total,
  tone = "success",
}: {
  value: number;
  total: number;
  tone?: "success" | "accent";
}) {
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]">
      <div style={{ width: ratioWidth(value, total), background: `var(--color-${tone})` }} />
    </div>
  );
}

/** A section of CSS width in the ratio bar */
export function ratioWidth(value: number, total: number): string {
  return total > 0 ? `${Math.min(100, (value / total) * 100)}%` : "0%";
}

export function percent(value: number, total: number): string {
  if (total <= 0) return "0%";
  const ratio = (value / total) * 100;
  return `${ratio > 0 && ratio < 1 ? "<1" : Math.round(ratio)}%`;
}

/** Small text buttons: Details, secondary actions in the panel */
export function LinkButton({
  onClick,
  children,
  title,
  disabled,
  tone = "accent",
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
  tone?: "accent" | "muted" | "warn";
}) {
  const color = tone === "accent" ? "var(--color-accent)" : tone === "warn" ? "var(--color-warn)" : "var(--color-ink-faint)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="shrink-0 text-[10.5px] underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-60"
      style={{ color }}
    >
      {children}
    </button>
  );
}
