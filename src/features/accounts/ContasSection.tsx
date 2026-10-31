import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";
import { agentName } from "@/features/agents/agentTile";
import { SettingsGroup } from "@/features/settings/SettingsSection";
import { NotificationsSetting } from "@/features/settings/NotificationsSetting";

import { AccountsManager, type AccountsSection } from "./AccountsManager";
import { AddAccountDialog } from "./AddAccountDialog";
import { meterTone } from "./meter";
import { PoolsSection } from "./PoolsSection";
import { accountEnv, codexAccountUsage } from "./ipc";
import { useAccountsStore } from "./store";
import type { AgentAccount } from "./types";
import { agentAccountUsage, claudeLiveUsage, formatRemaining, humanPlan } from "./usage";

/** Um perfil sintético (`system:*`) não tem linha no banco: para o backend é `null`. */
const realId = (a: AgentAccount) => (a.id.startsWith("system:") ? null : a.id);

interface Meter { key: string; label: string; percent: number; resets: string | null }
interface AccountInfo { plan: string | null; meters: Meter[] }

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** O plano e as barras de cota de uma conta, como a TUI os informa. */
async function fetchInfo(account: AgentAccount, force: boolean, t: Translate): Promise<AccountInfo> {
  const name = agentName(account.agentId);
  const meters: Meter[] = [];
  let plan: string | null = null;
  if (account.agentId === "claude-code") {
    const usage = await agentAccountUsage(account.agentId, realId(account)).catch(() => null);
    if (usage) plan = humanPlan(usage.plan.tier);
    const env = realId(account) ? await accountEnv(account.id) : {};
    const live = await claudeLiveUsage(account.id, env, force);
    if (live.available && live.session) meters.push({ key: "session", label: `${name} · ${t("accounts.plan.session")}`, percent: live.session.percent, resets: live.session.resets });
    if (live.available && live.week) meters.push({ key: "week", label: `${name} · ${t("accounts.plan.week")}`, percent: live.week.percent, resets: live.week.resets });
  } else if (account.agentId === "codex") {
    const usage = await codexAccountUsage(account.id);
    const now = Date.now() / 1000;
    const when = (at: number | null) => (at ? t("settings.accounts.resetsIn", { time: formatRemaining(at - now) }) : null);
    if (usage.quota?.fiveHour) meters.push({ key: "5h", label: `${name} · ${t("accounts.plan.session")}`, percent: Math.round(usage.quota.fiveHour.utilization * 100), resets: when(usage.quota.fiveHour.resetsAt) });
    if (usage.quota?.sevenDay) meters.push({ key: "7d", label: `${name} · ${t("accounts.plan.week")}`, percent: Math.round(usage.quota.sevenDay.utilization * 100), resets: when(usage.quota.sevenDay.resetsAt) });
    plan = usage.plan ?? null;
  }
  return { plan, meters };
}

/** Uma consulta por conta e por "atualizar", mesmo que a linha e o uso a peçam juntos. */
const inflight = new Map<string, Promise<AccountInfo>>();

function useAccountInfo(account: AgentAccount, reload: number): AccountInfo & { loading: boolean } {
  const { t, i18n } = useTranslation();
  const [info, setInfo] = useState<AccountInfo & { loading: boolean }>({ plan: null, meters: [], loading: true });
  useEffect(() => {
    let stale = false;
    setInfo((cur) => ({ ...cur, loading: true }));
    const key = `${account.id}:${reload}:${i18n.language}`;
    let promise = inflight.get(key);
    if (!promise) {
      promise = fetchInfo(account, reload > 0, t as Translate).catch(() => ({ plan: null, meters: [] }));
      inflight.set(key, promise);
      // Fica guardada só o tempo de as duas linhas a pedirem: depois, uma nova consulta é uma nova.
      window.setTimeout(() => inflight.delete(key), 4000);
    }
    promise.then((r) => { if (!stale) setInfo({ ...r, loading: false }); });
    return () => { stale = true; };
  }, [account.id, account.agentId, reload, t, i18n.language]); // eslint-disable-line react-hooks/exhaustive-deps
  return info;
}

/**
 * A seção Contas (prancheta 6): os agentes em abas; as contas do escolhido num cartão, cada uma
 * com o estado e as barras de cota (janela atual e semana); os pools; e, embaixo, o gerenciador
 * completo (limites, chaves e as contas do git), que continua sendo o lugar de tudo isso.
 */
export function ContasSection() {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const capable = useAccountsStore((s) => s.capable);
  const load = useAccountsStore((s) => s.load);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);
  const [focus, setFocus] = useState<AccountsSection | null>(null);
  const manager = useRef<HTMLDivElement>(null);
  useEffect(() => { load().catch(() => undefined); }, [load]);

  const agentId = picked ?? capable[0]?.agentId ?? null;
  const agent = capable.find((c) => c.agentId === agentId) ?? null;
  const rows = useMemo(
    () => [...systemAccounts, ...accounts].filter((a) => a.agentId === agentId),
    [systemAccounts, accounts, agentId],
  );
  const manage = useCallback((account: AgentAccount) => {
    setFocus({ kind: "agent", id: account.agentId });
    requestAnimationFrame(() => manager.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  return (
    <>
      <div role="tablist" aria-label={t("settings.agents")} className="flex flex-wrap gap-1">
        {capable.map((c) => {
          const Icon = agentIcon(c.agentId, c.label);
          const on = c.agentId === agentId;
          return (
            <button key={c.agentId} type="button" role="tab" aria-selected={on} onClick={() => setPicked(c.agentId)}
              className={`inline-flex items-center gap-1.5 h-[30px] px-2.5 rounded-lg text-[13px] font-medium
                ${on ? "bg-white dark:bg-white/[0.07] text-gray-900 dark:text-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                  : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.05]"}`}>
              <Icon className="w-4 h-4" />{c.label}
            </button>
          );
        })}
      </div>

      {agent && (
        <section aria-label={t("chat.accounts.of", { agent: agent.label })} className="flex flex-col gap-2">
          <div className="flex items-center gap-2 mx-1">
            <h2 className="m-0 flex-1 text-[13px] font-medium text-gray-500 dark:text-white/50">{t("chat.accounts.of", { agent: agent.label })}</h2>
            <button type="button" onClick={() => setReload((n) => n + 1)}
              className="h-7 px-2 rounded-md text-[12.5px] text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.06]">{t("accounts.plan.refresh")}</button>
            <button type="button" onClick={() => setAdding(true)}
              className="h-7 px-2.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-[13px] font-medium">+ {t("settings.accounts.add")}</button>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] divide-y divide-gray-200 dark:divide-white/[0.08]">
            {rows.length === 0 && <p className="m-0 px-4 py-5 text-[13px] text-gray-400 dark:text-white/40">{t("settings.accounts.emptyForAgent")}</p>}
            {rows.map((a) => <ChatAccountRow key={a.id} account={a} reload={reload} onManage={manage} />)}
          </div>
        </section>
      )}

      {agent && (
        <section aria-label={t("chat.accounts.pools")} className="flex flex-col gap-2">
          <h2 className="m-0 mx-1 text-[13px] font-medium text-gray-500 dark:text-white/50">{t("chat.accounts.pools")}</h2>
          <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-4 py-3.5">
            <PoolsSection agent={agent} />
          </div>
        </section>
      )}

      <section aria-label={t("settings.accounts.prefs")} className="flex flex-col gap-2">
        <h2 className="m-0 mx-1 text-[13px] font-medium text-gray-500 dark:text-white/50">{t("settings.accounts.prefs")}</h2>
        <SettingsGroup><NotificationsSetting /></SettingsGroup>
      </section>

      <section ref={manager} aria-label={t("settings.accounts.manager")} className="flex flex-col gap-2 scroll-mt-4">
        <h2 className="m-0 mx-1 text-[13px] font-medium text-gray-500 dark:text-white/50">{t("chat.accounts.more")}</h2>
        <AccountsManager focus={focus} />
      </section>

      {adding && agent && <AddAccountDialog agentId={agent.agentId} onClose={() => setAdding(false)} />}
    </>
  );
}

/** Uma conta no cartão: inicial, nome, estado e as barras de cota. */
function ChatAccountRow({ account, reload, onManage }: { account: AgentAccount; reload: number; onManage: (a: AgentAccount) => void }) {
  const { t } = useTranslation();
  const health = useAccountsStore((s) => s.health[account.id]);
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const { plan, meters, loading } = useAccountInfo(account, reload);
  const state: "checking" | "ok" | "bad" | "off" =
    health === "checking" ? "checking"
    : health ? (health.status === "ok" ? "ok" : health.status === "invalid" ? "bad" : "off")
    : account.loggedIn ? "ok" : "off";
  const tone = state === "ok" ? "text-emerald-700 dark:text-emerald-400" : state === "bad" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400";
  const main = account.id.startsWith("system:");
  const name = account.label ?? account.name;
  const meterLabel = (key: string) => (key === "session" || key === "5h" ? t("chat.accounts.window") : t("chat.accounts.week"));
  return (
    <div className="flex gap-3 px-4 py-3.5">
      <span aria-hidden="true" className="w-8 h-8 shrink-0 rounded-full bg-gray-100 dark:bg-white/[0.06] flex items-center justify-center text-[13px] font-semibold text-gray-600 dark:text-white/60">
        {name.charAt(0).toUpperCase()}
      </span>
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[14px] min-w-0">
          <b className="font-medium truncate">{name}</b>
          {main && <span className="shrink-0 text-[11px] px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">{t("chat.accounts.main")}</span>}
          {account.kind === "api_key" && <span className="shrink-0 text-[11px] px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">API key</span>}
          <span className={`ml-auto shrink-0 text-[12px] ${tone}`}>● {t(`settings.accounts.state.${state}`)}</span>
        </div>
        {meters.length > 0 && (
          <div className="grid grid-cols-2 gap-4 text-[12px] text-gray-500 dark:text-white/50">
            {meters.map((m) => (
              <div key={m.key}>
                <div className="flex justify-between mb-1"><span>{meterLabel(m.key)}</span><span className="font-mono">{m.percent}%</span></div>
                <div className="h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                  <div className={`h-full rounded-full ${meterTone(m.percent)}`} style={{ width: `${Math.min(100, Math.max(0, m.percent))}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-gray-400 dark:text-white/40">
          {plan && <span>{plan}</span>}
          {plan && <span aria-hidden="true">·</span>}
          {loading && meters.length === 0 ? <span>{t("accounts.plan.asking")}</span> : meters.length === 0 && <span>{t("accounts.plan.unsupported")}</span>}
          <button type="button" onClick={() => void checkHealth(account.id)} className="hover:text-gray-700 dark:hover:text-white/70">{t("settings.accounts.verify")}</button>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => onManage(account)} className="hover:text-gray-700 dark:hover:text-white/70">{t("settings.accounts.manage")}</button>
        </div>
      </div>
    </div>
  );
}
