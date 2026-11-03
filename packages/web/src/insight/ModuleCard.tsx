import type { ModuleCardDto, ModuleLinkDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Chip, LinkButton, RowButton, Section } from "../ui/panel";
import { IO_LABELS } from "../ui/visual";
import { edgeSelection } from "../lib/edge";
import { ScopeTests } from "./TestsSection";

const API_SHOWN = 12;

/**
 * Module business card: Everything you need to know when treating a package or directory as a black box—external interfaces, what it depends on, and who depends on it,
 * Which I/Os are involved, what are the entry points, how well it has been tested, and how frequently it is modified. If you understand the business card, there is no need to read its entire internals.
 */
export function ModuleCardSection({ nodeId }: { nodeId: string }) {
  const t = useT();
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [card, setCard] = useState<ModuleCardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void api.moduleCard(nodeId)
      .then((result) => !cancelled && setCard(result))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [nodeId, indexRevision]);

  if (error) return null;
  if (!card || card.id !== nodeId) {
    return <div className="mt-3 h-16 animate-pulse rounded bg-[var(--color-surface-2)]" />;
  }

  return (
    <>
      {(card.layer || card.io.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {card.layer && (
            <Chip tone={card.layer.confirmed ? "success" : "accent"} title={card.layer.confirmed ? t("确认过的分层") : t("AI 提议的分层，还没有人确认")}>
              {card.layer.name}
              {card.layer.confirmed ? "" : " · AI"}
            </Chip>
          )}
          {card.io.map((io) => (
            <Chip key={io.kind} tone="warn" title={t("{count} 个函数直接做这类 I/O", { count: io.functions })}>
              {t(IO_LABELS[io.kind])} {io.functions}
            </Chip>
          ))}
        </div>
      )}
      <ApiList card={card} />
      <Links title={t("它依赖 ({count})", { count: card.dependsOn.length })} links={card.dependsOn} from={nodeId} outgoing />
      <Links title={t("依赖它的 ({count})", { count: card.usedBy.length })} links={card.usedBy} from={nodeId} outgoing={false} />
      {card.externals.length > 0 && (
        <Section title={t("外部库 ({count})", { count: card.externals.length })}>
          <div className="flex flex-wrap gap-1">
            {card.externals.map((ext) => (
              <Chip key={ext.name} title={t("{count} 个文件引用", { count: ext.files })}>
                <span className="mono">{ext.name}</span>
              </Chip>
            ))}
          </div>
        </Section>
      )}
      <Entries card={card} />
      <ScopeTests nodeId={nodeId} tests={card.tests} />
      <History card={card} />
    </>
  );
}

function ApiList({ card }: { card: ModuleCardDto }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const [all, setAll] = useState(false);
  const shown = all ? card.api : card.api.slice(0, API_SHOWN);
  return (
    <Section
      title={t("对外接口 ({count})", { count: card.apiTotal })}
      aside={card.api.length > API_SHOWN && !all ? <LinkButton onClick={() => setAll(true)}>{t("全部")}</LinkButton> : undefined}
    >
      {card.api.length === 0 ? (
        <p className="text-[11px] text-[var(--color-ink-faint)]">{t("模块外没有用到它的任何符号")}</p>
      ) : (
        <div className="space-y-0.5">
          {shown.map((api) => (
            <RowButton
              key={api.id}
              onClick={() => select(api.id)}
              title={api.signature ?? undefined}
              meta={api.callers > 0 ? t("{count} 处调用方", { count: api.callers }) : t("{count} 个文件引用", { count: api.files })}
            >
              <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">{api.name}</span>
              {api.signature && (
                <span className="mono min-w-0 truncate text-[10px] text-[var(--color-ink-faint)]">{compactSignature(api.signature, api.name)}</span>
              )}
            </RowButton>
          ))}
        </div>
      )}
      <p className="mt-1 text-[10.5px] text-[var(--color-ink-faint)]">
        {t("按模块外的调用方数排。接口没变，内部怎么改都不影响用它的人。")}
      </p>
    </Section>
  );
}

function Links({ title, links, from, outgoing }: { title: string; links: ModuleLinkDto[]; from: string; outgoing: boolean }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  if (links.length === 0) return null;
  return (
    <Section title={title}>
      <div className="space-y-0.5">
        {links.map((link) => (
          <RowButton
            key={link.id}
            onClick={() => select(outgoing ? edgeSelection(from, link.id) : edgeSelection(link.id, from))}
            title={t("看这条依赖由什么构成")}
            meta={link.imports > 0 ? t("{count} 条 import", { count: link.imports }) : undefined}
          >
            <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">{link.label}</span>
            {link.typeOnly && <Chip>{t("仅类型")}</Chip>}
            {link.http && <Chip tone="warn">HTTP</Chip>}
            {link.names.length > 0 && (
              <span className="mono min-w-0 truncate text-[10px] text-[var(--color-ink-faint)]">{link.names.join(", ")}</span>
            )}
          </RowButton>
        ))}
      </div>
    </Section>
  );
}

function Entries({ card }: { card: ModuleCardDto }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const openWalk = useAppStore((s) => s.openWalk);
  if (card.entries.length === 0) return null;
  return (
    <Section title={t("入口 ({count})", { count: card.entries.length })}>
      <div className="space-y-0.5">
        {card.entries.slice(0, 20).map((entry) => (
          <RowButton
            key={entry.id}
            onClick={entry.symbolId ? () => openWalk(entry.symbolId!, entry.label) : () => select(entry.id)}
            title={entry.symbolId ? t("从这里开始单步走读") : undefined}
            meta={entry.kind}
          >
            <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">{entry.label}</span>
          </RowButton>
        ))}
      </div>
    </Section>
  );
}

function History({ card }: { card: ModuleCardDto }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  if (!card.history || card.history.commits === 0) return null;
  const { commits, recentCommits, aiCommits, hottest } = card.history;
  return (
    <Section title={t("改动热点")}>
      <p className="text-[11px] text-[var(--color-ink-muted)]">
        {t("近一年 {commits} 次提交，近 90 天 {recent} 次，{ai} 次标明有 AI 参与", { commits, recent: recentCommits, ai: aiCommits })}
      </p>
      {hottest.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {hottest.map((file) => (
            <RowButton
              key={file.id}
              onClick={() => select(file.id)}
              meta={t("近 90 天 {count} 次", { count: file.recentCommits })}
              title={t("改得勤又复杂的地方最容易出问题，也最值得先看懂")}
            >
              <span className="mono truncate text-[11px] text-[var(--color-ink-muted)]">{file.path}</span>
              {file.complexity >= 20 && <Chip tone="warn">{t("复杂度 {count}", { count: file.complexity })}</Chip>}
            </RowButton>
          ))}
        </div>
      )}
    </Section>
  );
}

/** Remove the name itself and modifiers like export/function from the signature, leaving only the parameters and return */
function compactSignature(signature: string, name: string): string {
  const at = signature.indexOf(name);
  const rest = at >= 0 ? signature.slice(at + name.length) : signature;
  return rest.replace(/\s+/g, " ").trim().slice(0, 80);
}
