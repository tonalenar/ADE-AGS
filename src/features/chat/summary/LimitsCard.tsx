import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { accountUsageSummary } from "@/features/accounts/ipc";
import { agentName } from "@/features/agents/agentTile";
import { useAccountsStore } from "@/features/accounts/store";
import type { AccountUsageSummary, AgentAccount } from "@/features/accounts/types";
import { formatRemaining } from "@/features/accounts/usage";
import { useUsageStore } from "@/features/canvas/usageStore";
import { Row, Section } from "@/features/sidePanel/Section";
import { useTabsStore } from "@/features/tabs/store";

import type { ConversationCard } from "../chatModel";
import { useChatLive } from "../liveStore";
import { threadIdOf } from "../structured/model";
import { useStructured } from "../structured/store";
import { teamLedBy } from "../team/teamModel";
import { startTeams, useTeamStore } from "../team/teamStore";
import {
  budgetOf, connectedAccounts, headlineOf, limitLevel, readAgy, readAntigravity, readClaude, readCodex, renewal, usedAccounts,
  type AccountEntry, type AccountLike, type AccountReading, type Budget, type LimitLevel, type LimitWindow,
} from "./limitsModel";

/** Os agentes cuja cota o ADE mede de verdade (ver `usageStore`). */
const MEASURED_AGENTS = new Set(["claude-code", "codex", "antigravity"]);

const FILL: Record<LimitLevel, string> = {
  unknown: "bg-gray-300 dark:bg-white/25",
  ok: "bg-accent-500",
  warn: "bg-amber-500",
  full: "bg-rose-500",
};
const TEXT: Record<LimitLevel, string> = {
  unknown: "text-gray-500 dark:text-white/45",
  ok: "text-gray-700 dark:text-gray-200",
  warn: "text-amber-700 dark:text-amber-400",
  full: "text-rose-700 dark:text-rose-400",
};

interface Who {
  /** A conversa ou o integrante, para o rótulo. */
  name: string;
  agentId: string;
  accountId: string | null | undefined;
}

/** Quem usa o quê: a conversa e, no orquestrador de um time, cada integrante. A conversa vem primeiro. */
function useWhos(conversation: ConversationCard): Who[] {
  const tabs = useTabsStore((s) => s.tabs);
  const threads = useStructured((s) => s.threads);
  const team = useTeamStore((s) => teamLedBy(s.teams, conversation.tabId));
  return useMemo(() => {
    const accountOf = (ref: string): string | null | undefined => {
      const thread = threadIdOf(ref);
      return thread ? threads.find((t) => t.id === thread)?.accountId : tabs.find((t) => t.id === ref)?.accountId;
    };
    const own: Who = { name: conversation.agentLabel, agentId: conversation.agentId, accountId: accountOf(conversation.tabId) };
    const others = (team?.members ?? []).map((m): Who => ({ name: m.label || m.agentId, agentId: m.agentId, accountId: accountOf(m.member) }));
    return [own, ...others];
  }, [conversation.tabId, conversation.agentId, conversation.agentLabel, tabs, threads, team]);
}

/** Cada vez que uma das conversas termina um turno (trabalhando → parada) o número sobe. */
function useTurnEnds(refs: string[]): number {
  const workingNow = useChatLive((s) => refs.filter((r) => s.phase[r] === "working").join("|"));
  const threadsWorking = useStructured((s) => refs.filter((r) => { const id = threadIdOf(r); return !!id && s.live[id]?.phase === "working"; }).join("|"));
  const now = useMemo(() => new Set([...workingNow.split("|"), ...threadsWorking.split("|")].filter(Boolean)), [workingNow, threadsWorking]);
  const before = useRef<Set<string>>(new Set());
  const [ends, setEnds] = useState(0);
  useEffect(() => {
    if ([...before.current].some((r) => !now.has(r))) setEnds((n) => n + 1);
    before.current = now;
  }, [now]);
  return ends;
}

/**
 * O cartão "Limites de uso" do Resumo: a cota da conta que a conversa usa (janela atual e semanal) e, num
 * time, as contas dos integrantes, recolhidas. Lê o `useUsageStore` (o mesmo do painel "Uso" do rodapé da
 * barra) e só pede de novo ao abrir o Resumo e ao fim de cada turno, com a validade do store (uma TUI só
 * sobe se a leitura tiver mais de 5 min). Sem fonte ou com falha: "não medido", sem barra.
 */
export function LimitsCard({ conversation }: { conversation: ConversationCard }) {
  const { t } = useTranslation();
  const whos = useWhos(conversation);
  const used = useMemo(() => usedAccounts(whos), [whos]);
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const loaded = useAccountsStore((s) => s.loaded);
  const claude = useUsageStore((s) => s.claude);
  const codex = useUsageStore((s) => s.codex);
  const antigravity = useUsageStore((s) => s.antigravity);
  const agy = useUsageStore((s) => s.agy);
  const [summaries, setSummaries] = useState<Record<string, AccountUsageSummary>>({});
  useEffect(() => startTeams(), []);

  const refs = useMemo(() => [conversation.tabId], [conversation.tabId]);
  const turnEnds = useTurnEnds(refs);
  // TODAS as contas conectadas dos agentes que expõem a cota, as da conversa primeiro; uma barra por janela em cada.
  const entries = useMemo(
    () => connectedAccounts({ accounts, systemAccounts, used, measured: MEASURED_AGENTS, agyInstalled: agy.usage?.installed ?? false }),
    [accounts, systemAccounts, used, agy.usage?.installed],
  );

  // Ao abrir o Resumo e ao fim de um turno: relê as contas (login e criação acontecem fora da tela) e a cota de cada
  // uma, com a validade do store (uma TUI do Claude só sobe se a leitura tiver mais de 5 min); o `agy` local também.
  const keys = entries.map((e) => e.key).join("|");
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (!loaded) await useAccountsStore.getState().load().catch(() => undefined);
      const { refresh, refreshAgy } = useUsageStore.getState();
      void refreshAgy(false);
      for (const entry of entries) {
        if (entry.account && MEASURED_AGENTS.has(entry.agentId) && !(entry.agentId === "antigravity" && !entry.accountId)) void refresh(entry.account as AgentAccount, false);
      }
      const rows = await accountUsageSummary(1).catch(() => [] as AccountUsageSummary[]);
      if (alive) setSummaries(Object.fromEntries(rows.map((r) => [r.accountKey, r])));
    };
    void run();
    return () => { alive = false; };
  }, [keys, turnEnds]); // eslint-disable-line react-hooks/exhaustive-deps -- `entries` muda com `keys`; `loaded` só vale na primeira vez

  const now = Math.floor(Date.now() / 1000);
  const readingOf = (entry: AccountEntry): AccountReading => {
    if (!MEASURED_AGENTS.has(entry.agentId)) return { state: "unmeasured", reason: "noSource" };
    // O Antigravity sem perfil é o login local do `agy`: a mesma leitura do canvas.
    if (entry.agentId === "antigravity" && !entry.accountId) return readAgy(agy, true, now);
    const account = entry.account;
    if (!account) return { state: "unmeasured", reason: loaded ? "noSource" : "loading" };
    if (entry.agentId === "claude-code") return readClaude(claude[account.id] ?? null, account.loggedIn, now);
    if (entry.agentId === "codex") return readCodex(codex[account.id], account.loggedIn, now);
    return readAntigravity(antigravity[account.id], account.loggedIn, now);
  };

  const [main, ...rest] = entries;
  const mainReading = main ? readingOf(main) : null;
  const headline = mainReading ? headlineOf(mainReading) : null;

  return (
    <Section id="limits" title={t("chat.summary.limits.title")} flat
      aside={headline !== null && (
        <span className={`text-[11px] tabular-nums ${TEXT[limitLevel(headline)]}`}>{headline}%</span>
      )}>
      {entries.length === 0 && <Row><span className="text-gray-500 dark:text-white/45">{t("chat.summary.limits.reason.noSource")}</span></Row>}
      {main && mainReading && (
        <AccountBlock entry={main} reading={mainReading} budget={budgetOf(summaries[main.key])} now={now} />
      )}
      {rest.length > 0 && (
        <div className="mt-2 pt-3 border-t border-gray-200 dark:border-white/[0.08] flex flex-col gap-4">
          <div className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-white/35">{t("chat.summary.limits.others", { count: rest.length })}</div>
          {rest.map((entry) => (
            <AccountBlock key={entry.key} entry={entry} reading={readingOf(entry)} budget={budgetOf(summaries[entry.key])} now={now} />
          ))}
        </div>
      )}
    </Section>
  );
}

function accountName(account: AccountLike | null, t: (k: string) => string): string {
  return account && !account.id.startsWith("system:") ? account.label ?? account.name : t("accounts.system");
}

/** Uma conta: «Agente · conta» (e quem da conversa a usa), e uma barra por janela, ou «não medido» com o motivo. */
function AccountBlock({ entry, reading, budget, now }: { entry: AccountEntry; reading: AccountReading; budget: Budget | null; now: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <div className="px-0.5 text-[12px] text-gray-500 dark:text-white/45 truncate" title={entry.who.join(", ")}>
        <span className="font-medium text-gray-800 dark:text-white/85">{agentName(entry.agentId)}</span>
        {" · "}{accountName(entry.account, t)}
        {entry.who.length > 0 && <span className="text-gray-400 dark:text-white/35">{" · "}{t("chat.summary.limits.usedBy", { who: entry.who.join(", ") })}</span>}
      </div>
      {reading.state === "measured" ? (
        <>
          {reading.windows.map((w, i) => <WindowBar key={`${w.kind}:${w.label ?? ""}:${i}`} window={w} now={now} rejected={reading.rejected} />)}
          {reading.rejected && reading.windows.length === 0 && <Row><span className={TEXT.full}>{t("chat.summary.limits.exhausted")}</span></Row>}
        </>
      ) : (
        <Unmeasured reason={reading.reason} />
      )}
      {budget && <BudgetBar budget={budget} />}
    </div>
  );
}

function Unmeasured({ reason }: { reason: string }) {
  const { t } = useTranslation();
  return (
    <Row>
      <span className="text-gray-500 dark:text-white/45">
        {reason === "loading" ? t("chat.summary.limits.reading") : `${t("chat.summary.notMeasured")} · ${t(`chat.summary.limits.reason.${reason}`)}`}
      </span>
    </Row>
  );
}

function WindowBar({ window: w, now, rejected }: { window: LimitWindow; now: number; rejected: boolean }) {
  const { t, i18n } = useTranslation();
  const kindLabel = w.kind === "session" ? t("chat.accounts.window") : t("chat.accounts.week");
  // Um grupo de modelos (Antigravity) leva o nome na frente da janela; a de um modelo é só o nome.
  const label = w.kind === "model" ? w.label ?? "" : w.label ? `${w.label} · ${kindLabel}` : kindLabel;
  const level = rejected && w.kind === "session" ? "full" : limitLevel(w.percent);
  const when = renewalText(w, now, i18n.language, t);
  return <Bar label={label} percent={w.percent} level={level} detail={w.expired ? t("chat.summary.limits.renewed") : when} />;
}

function renewalText(w: LimitWindow, now: number, language: string, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  if (w.resetsText) return t("chat.summary.limits.renewsText", { when: w.resetsText });
  const r = renewal(w.kind, w.resetsAt, now);
  if (!r || r.kind === "passed") return null;
  if (r.kind === "in") return t("chat.summary.limits.renewsIn", { time: formatRemaining(r.seconds) });
  const when = new Intl.DateTimeFormat(language, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(r.epoch * 1000));
  return t("chat.summary.limits.renewsAt", { when });
}

function BudgetBar({ budget }: { budget: Budget }) {
  const { t } = useTranslation();
  return (
    <Bar label={t("chat.summary.limits.budget")} percent={budget.percent} level={limitLevel(budget.percent)}
      detail={t("chat.summary.limits.budgetOf", { spent: budget.spent.toFixed(2), budget: budget.budget.toFixed(2) })} />
  );
}

/** Uma barra discreta: o texto diz o nível (não só a cor) e a barra é um `progressbar` para o leitor de tela. */
function Bar({ label, percent, level, detail }: { label: string; percent: number | null; level: LimitLevel; detail: string | null }) {
  const { t } = useTranslation();
  const state = level === "full" ? t("chat.summary.limits.exhausted") : level === "warn" ? t("chat.summary.limits.nearLimit") : null;
  return (
    <div className="flex flex-col gap-1 px-0.5">
      <div className="flex items-baseline gap-2 text-[12.5px]">
        <span className="min-w-0 truncate text-gray-700 dark:text-gray-200">{label}</span>
        <span className="flex-1" />
        {state && <span className={`shrink-0 text-[11px] font-medium ${TEXT[level]}`}>{state}</span>}
        <span className={`shrink-0 tabular-nums ${TEXT[level]}`}>{percent === null ? t("chat.summary.notMeasured") : `${percent}%`}</span>
      </div>
      {percent !== null && (
        <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
          aria-valuetext={`${percent}%${state ? ` · ${state}` : ""}`}
          className="relative h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
          <span className={`absolute inset-y-0 left-0 rounded-full ${FILL[level]}`} style={{ width: `${percent}%` }} />
        </div>
      )}
      {detail && <div className="text-[11.5px] text-gray-400 dark:text-white/35">{detail}</div>}
    </div>
  );
}
