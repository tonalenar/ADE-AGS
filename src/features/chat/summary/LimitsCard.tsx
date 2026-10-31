import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { accountUsageSummary } from "@/features/accounts/ipc";
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
  accountKeyOf, budgetOf, headlineOf, limitLevel, readAntigravity, readClaude, readCodex, renewal, usedAccounts,
  type AccountReading, type Budget, type LimitLevel, type LimitWindow, type UsedAccount,
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
  const [summaries, setSummaries] = useState<Record<string, AccountUsageSummary>>({});
  const [teamOpen, setTeamOpen] = useState(false);
  useEffect(() => startTeams(), []);

  const refs = useMemo(() => [conversation.tabId], [conversation.tabId]);
  const turnEnds = useTurnEnds(refs);
  const accountOf = (u: UsedAccount): AgentAccount | null =>
    (u.accountId ? accounts.find((a) => a.id === u.accountId) : systemAccounts.find((a) => a.agentId === u.agentId)) ?? null;

  // Ao abrir o Resumo e ao fim de um turno: relê as contas (login e criação acontecem fora da tela) e a cota.
  const keys = used.map((u) => u.key).join("|");
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (!loaded) await useAccountsStore.getState().load().catch(() => undefined);
      const { accounts: acc, systemAccounts: sys } = useAccountsStore.getState();
      for (const u of used) {
        const account = (u.accountId ? acc.find((a) => a.id === u.accountId) : sys.find((a) => a.agentId === u.agentId)) ?? null;
        if (account && MEASURED_AGENTS.has(u.agentId)) void useUsageStore.getState().refresh(account, false);
      }
      const rows = await accountUsageSummary(1).catch(() => [] as AccountUsageSummary[]);
      if (alive) setSummaries(Object.fromEntries(rows.map((r) => [r.accountKey, r])));
    };
    void run();
    return () => { alive = false; };
  }, [keys, turnEnds]); // eslint-disable-line react-hooks/exhaustive-deps -- `used` muda com `keys`; `loaded` só vale na primeira vez

  const now = Math.floor(Date.now() / 1000);
  const readingOf = (u: UsedAccount): AccountReading => {
    if (!MEASURED_AGENTS.has(u.agentId)) return { state: "unmeasured", reason: "noSource" };
    const account = accountOf(u);
    if (!account) return { state: "unmeasured", reason: loaded ? "noSource" : "loading" };
    const loggedIn = account.loggedIn;
    if (u.agentId === "claude-code") return readClaude(claude[account.id] ?? null, loggedIn, now);
    if (u.agentId === "codex") return readCodex(codex[account.id], loggedIn, now);
    return readAntigravity(antigravity[account.id], loggedIn, now);
  };

  const [main, ...rest] = used;
  const mainReading = main ? readingOf(main) : null;
  const headline = mainReading ? headlineOf(mainReading) : null;

  return (
    <Section id="limits" title={t("chat.summary.limits.title")} flat
      aside={headline !== null && (
        <span className={`text-[11px] tabular-nums ${TEXT[limitLevel(headline)]}`}>{headline}%</span>
      )}>
      {main && mainReading && <AccountBlock used={main} account={accountOf(main)} reading={mainReading} budget={budgetOf(summaries[accountKeyOf(main.agentId, main.accountId)])} now={now} />}
      {rest.length > 0 && (
        <>
          <button type="button" onClick={() => setTeamOpen(!teamOpen)} aria-expanded={teamOpen}
            className="self-start mt-1 px-1.5 text-[12.5px] text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white">
            {teamOpen ? t("chat.summary.limits.teamHide") : t("chat.summary.limits.teamShow", { count: rest.length })}
          </button>
          {teamOpen && rest.map((u) => (
            <TeamAccountRow key={u.key} used={u} account={accountOf(u)} reading={readingOf(u)} />
          ))}
        </>
      )}
    </Section>
  );
}

function accountName(account: AgentAccount | null, t: (k: string) => string): string {
  return account && !account.id.startsWith("system:") ? account.label ?? account.name : t("accounts.system");
}

function AccountBlock({ used, account, reading, budget, now }: { used: UsedAccount; account: AgentAccount | null; reading: AccountReading; budget: Budget | null; now: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <div className="px-0.5 text-[12px] text-gray-500 dark:text-white/45 truncate" title={used.who.join(", ")}>
        {t("chat.summary.limits.account", { account: accountName(account, t) })}
      </div>
      {reading.state === "measured" ? (
        <>
          {reading.windows.map((w, i) => <WindowBar key={`${w.kind}:${i}`} window={w} now={now} rejected={reading.rejected} />)}
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
  const label = w.kind === "model" ? w.label ?? "" : w.kind === "session" ? t("chat.accounts.window") : t("chat.accounts.week");
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

/** Uma conta usada por outros do time: agente · conta · % da janela atual. */
function TeamAccountRow({ used, account, reading }: { used: UsedAccount; account: AgentAccount | null; reading: AccountReading }) {
  const { t } = useTranslation();
  const session = reading.state === "measured" ? reading.windows.find((w) => w.kind === "session" || w.kind === "model") ?? null : null;
  const percent = session?.percent ?? null;
  const level = reading.state === "measured" && reading.rejected ? "full" : limitLevel(percent);
  const status = reading.state === "measured"
    ? percent !== null ? `${percent}%` : t("chat.summary.notMeasured")
    : `${t("chat.summary.notMeasured")} · ${t(`chat.summary.limits.reason.${reading.reason}`)}`;
  return (
    <Row title={used.who.join(", ")}
      trailing={<span className={`shrink-0 tabular-nums text-[12px] ${TEXT[level]}`}>{status}{level === "warn" ? ` · ${t("chat.summary.limits.nearLimit")}` : level === "full" ? ` · ${t("chat.summary.limits.exhausted")}` : ""}</span>}>
      {used.who[0]} · {accountName(account, t)}
    </Row>
  );
}
