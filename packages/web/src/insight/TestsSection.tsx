import type { SpecDto, TestCoverageDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Chip, LinkButton, RatioBar, RowButton, Section, percent } from "../ui/panel";

/**
 * A function's 'tests that describe it': obtain the test cases by following its calls, with the closer ones first. The test case title is the expected behavior written by humans,
 * More reliable than AI summaries; if there are none, just say so honestly. There is no safety net for you when modifying it without testing.
 */
export function SymbolTests({ nodeId, coverage }: { nodeId: string; coverage: TestCoverageDto | null | undefined }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const [all, setAll] = useState(false);

  if (!coverage || coverage.total === 0) {
    return (
      <Section title={t("描述它的测试")}>
        <p className="text-[11px] leading-relaxed text-[var(--color-warn)]">
          {t("没有测试用例沿调用关系走得到它。改它时没有测试会替你发现回归。")}
        </p>
      </Section>
    );
  }

  return (
    <Section
      title={t("描述它的测试 ({count})", { count: coverage.total })}
      aside={coverage.total > coverage.nearest.length && !all
        ? <LinkButton onClick={() => setAll(true)}>{t("全部用例")}</LinkButton>
        : undefined}
    >
      {all ? (
        <SpecTree nodeId={nodeId} />
      ) : (
        <div className="space-y-0.5">
          {coverage.nearest.map((test) => (
            <RowButton
              key={test.id}
              onClick={() => select(test.id)}
              title={`${test.path}:${test.line}`}
              meta={test.depth === 1 ? t("直接调用") : t("隔 {count} 层", { count: test.depth })}
            >
              <span className="truncate text-[11.5px] text-[var(--color-ink)]">
                {test.suite && <span className="text-[var(--color-ink-faint)]">{test.suite} › </span>}
                {test.name}
              </span>
            </RowButton>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-[10.5px] text-[var(--color-ink-faint)]">
        {t("其中 {direct} 个直接调用它。用例标题就是人写下的预期行为。", { direct: coverage.direct })}
      </p>
    </Section>
  );
}

/** Overview of test coverage for files, directories, and packages; clicking on it shows the specifications organized by test files and test case groups. */
export function ScopeTests({
  nodeId,
  tests,
}: {
  nodeId: string;
  tests: { functions: number; covered: number; cases: number } | null | undefined;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!tests || tests.functions === 0) return null;
  return (
    <Section
      title={t("测试覆盖")}
      aside={tests.cases > 0 ? <LinkButton onClick={() => setOpen(!open)}>{open ? t("收起") : t("看规格")}</LinkButton> : undefined}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <RatioBar value={tests.covered} total={tests.functions} tone="accent" />
        </div>
        <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--color-ink-muted)]">
          {t("{covered}/{total} 个函数 · {share}", { covered: tests.covered, total: tests.functions, share: percent(tests.covered, tests.functions) })}
        </span>
      </div>
      <p className="mt-1 text-[10.5px] text-[var(--color-ink-faint)]">
        {tests.cases > 0
          ? t("{count} 个测试用例沿调用走得到这里（静态推算，不是运行时覆盖率）", { count: tests.cases })
          : t("没有测试用例沿调用走得到这里")}
      </p>
      {open && <div className="mt-2"><SpecTree nodeId={nodeId} /></div>}
    </Section>
  );
}

/** Test case list organized by test files and test case groups */
export function SpecTree({ nodeId }: { nodeId: string }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [spec, setSpec] = useState<SpecDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSpec(null);
    setError(null);
    void api.spec(nodeId)
      .then((result) => !cancelled && setSpec(result))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [nodeId, indexRevision]);

  if (error) return <div className="text-[11px] text-[var(--color-warn)]">{error}</div>;
  if (!spec) return <div className="text-[11px] text-[var(--color-ink-faint)]">{t("正在整理用例…")}</div>;
  if (spec.cases === 0) return <div className="text-[11px] text-[var(--color-ink-faint)]">{t("没有测试用例沿调用走得到这里")}</div>;

  return (
    <div className="space-y-2">
      {spec.files.map((file) => (
        <div key={file.id}>
          <button
            type="button"
            onClick={() => select(file.id)}
            className="mono block w-full truncate text-left text-[10.5px] text-[var(--color-ink-faint)] hover:text-[var(--color-accent)]"
          >
            {file.path}
          </button>
          {file.suites.map((suite, index) => (
            <div key={`${suite.name ?? ""}:${index}`} className={suite.name ? "ml-1.5 mt-0.5 border-l border-[var(--color-line)] pl-2" : ""}>
              {suite.name && <div className="text-[10.5px] text-[var(--color-ink-muted)]">{suite.name}</div>}
              {suite.cases.map((c) => (
                <RowButton
                  key={c.id}
                  onClick={() => select(c.id)}
                  title={c.targets.length > 0 ? t("走到 {names}", { names: c.targets.join(", ") }) : undefined}
                  meta={`:${c.line}`}
                >
                  <span className="truncate text-[11px] text-[var(--color-ink)]">{c.name}</span>
                  {c.depth === 1 && <Chip tone="accent">{t("直接")}</Chip>}
                </RowButton>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
