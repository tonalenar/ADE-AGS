import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentName, agentTile, vendorOf } from "@/features/agents/agentTile";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { NotificationsSetting } from "@/features/settings/NotificationsSetting";
import { ContextMenu } from "@/shared/ui/ContextMenu";

import { AccountsManager, type AccountsSection } from "./AccountsManager";
import { accountEnv, codexAccountUsage } from "./ipc";
import { useAccountsStore } from "./store";
import type { AgentAccount } from "./types";
import { agentAccountUsage, claudeLiveUsage, formatRemaining, humanPlan } from "./usage";

/**
 * A seção Contas das Configurações (prancheta 5): as contas conectadas, o uso de cada plano e as
 * preferências — e, embaixo, o gerenciador completo (adicionar, verificar, limites, pools e as
 * contas do git) que antes era um modal à parte.
 */

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

const PILL: Record<string, string> = {
  "claude-code": "bg-[rgba(191,90,242,0.16)] text-[#a64ad8] dark:text-[#bf5af2]",
  codex: "bg-[rgba(10,132,255,0.16)] text-[#0a84ff]",
  antigravity: "bg-[rgba(255,214,10,0.16)] text-[#b38f00] dark:text-[#ffd60a]",
};

function initialsOf(account: AgentAccount): string {
  const base = (account.label ?? account.name).replace(/@.*/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const parts = base.split(" ").filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

function AccountRow({ account, first, reload, onManage }: {
  account: AgentAccount;
  first: boolean;
  reload: number;
  onManage: (account: AgentAccount) => void;
}) {
  const { t } = useTranslation();
  const health = useAccountsStore((s) => s.health[account.id]);
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const { plan: infoPlan } = useAccountInfo(account, reload);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const plan = (health && health !== "checking" ? health.plan : null) ?? infoPlan;
  const state: "checking" | "ok" | "bad" | "off" =
    health === "checking" ? "checking"
    : health ? (health.status === "ok" ? "ok" : health.status === "invalid" ? "bad" : "off")
    : account.loggedIn ? "ok" : "off";
  const tone = state === "ok" ? "text-emerald-600 dark:text-[#30d158]" : state === "bad" ? "text-red-600 dark:text-[#ff453a]" : "text-gray-400 dark:text-white/40";
  const dot = state === "ok" ? "bg-emerald-500 dark:bg-[#30d158] shadow-[0_0_0_2px_rgba(48,209,88,0.2)]" : state === "bad" ? "bg-red-500 dark:bg-[#ff453a]" : "bg-gray-400 dark:bg-white/35";
  const vendor = vendorOf(account.agentId);
  return (
    <div className="relative flex h-16 items-center gap-3 px-4">
      {!first && <span aria-hidden className="absolute left-[68px] right-0 top-0 h-px bg-black/[0.08] dark:bg-[rgba(84,84,88,0.55)]" />}
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)]"
        style={{ background: agentTile(account.agentId) }}>{initialsOf(account)}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] leading-[18px] font-medium text-gray-900 dark:text-[#f5f5f7]">{account.label ?? account.name}</span>
          {plan && <span className={`inline-flex h-[18px] shrink-0 items-center rounded-full px-2 text-[10.5px] font-semibold ${PILL[account.agentId] ?? "bg-black/[0.06] text-gray-600 dark:bg-white/[0.1] dark:text-white/70"}`}>{plan}</span>}
          {account.kind === "api_key" && <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-black/[0.06] px-2 text-[10.5px] font-semibold text-gray-600 dark:bg-white/[0.1] dark:text-white/70">API key</span>}
        </span>
        <span className="truncate text-[12px] leading-4 text-gray-500 dark:text-white/55">
          {agentName(account.agentId)}{vendor ? ` · ${vendor}` : ""}{account.id.startsWith("system:") ? ` · ${t("accounts.system")}` : ` · ${account.name}`}
        </span>
      </span>
      <span className={`flex shrink-0 items-center gap-1.5 text-[12.5px] ${tone}`}>
        <span className={`h-[7px] w-[7px] rounded-full ${dot}`} />
        {t(`settings.accounts.state.${state}`)}
      </span>
      <button type="button" aria-label={t("settings.accounts.more")} title={t("settings.accounts.more")}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 200, y: r.bottom + 4 }); }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-gray-500 hover:text-gray-900 dark:bg-white/[0.07] dark:text-white/60 dark:hover:text-white">
        <svg viewBox="0 0 18 18" aria-hidden className="h-4 w-4" fill="currentColor"><circle cx="4" cy="9" r="1.4" /><circle cx="9" cy="9" r="1.4" /><circle cx="14" cy="9" r="1.4" /></svg>
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { key: "check", label: t("settings.accounts.verify"), onSelect: () => { void checkHealth(account.id); } },
          { key: "manage", label: t("settings.accounts.manage"), onSelect: () => onManage(account) },
        ]} />
      )}
    </div>
  );
}

function UsageBlock({ accounts, reload }: { accounts: AgentAccount[]; reload: number }) {
  const { t } = useTranslation();
  // Uma linha de cada TUI: a conta principal dela (ou a primeira conectada).
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return accounts.filter((a) => (seen.has(a.agentId) ? false : (seen.add(a.agentId), true)));
  }, [accounts]);
  return (
    <>
      {rows.map((a) => <UsageRows key={a.id} account={a} reload={reload} />)}
      {rows.length === 0 && <p className="px-4 py-4 text-[12.5px] text-gray-400 dark:text-white/35">{t("settings.accounts.noUsage")}</p>}
    </>
  );
}

function UsageRows({ account, reload }: { account: AgentAccount; reload: number }) {
  const { t } = useTranslation();
  const { meters, loading } = useAccountInfo(account, reload);
  if (!loading && meters.length === 0) {
    return (
      <div className="flex min-h-12 items-center justify-between gap-4 border-t border-black/[0.08] px-4 py-3 first:border-t-0 dark:border-[rgba(84,84,88,0.55)]">
        <span className="text-[13.5px] text-gray-900 dark:text-[#f5f5f7]">{agentName(account.agentId)}</span>
        <span className="text-[12px] text-gray-400 dark:text-white/35">{t("accounts.plan.unsupported")}</span>
      </div>
    );
  }
  if (loading && meters.length === 0) {
    return (
      <div className="flex min-h-12 items-center justify-between gap-4 border-t border-black/[0.08] px-4 py-3 first:border-t-0 dark:border-[rgba(84,84,88,0.55)]">
        <span className="text-[13.5px] text-gray-900 dark:text-[#f5f5f7]">{agentName(account.agentId)}</span>
        <span className="text-[12px] text-gray-400 dark:text-white/35">{t("accounts.plan.asking")}</span>
      </div>
    );
  }
  return (
    <>
      {meters.map((m) => (
        <div key={m.key} className="border-t border-black/[0.08] px-4 py-3 first:border-t-0 dark:border-[rgba(84,84,88,0.55)]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[13.5px] text-gray-900 dark:text-[#f5f5f7]">{m.label}</span>
            <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-gray-500 dark:text-white/55">
              <b className="font-bold text-gray-900 dark:text-[#f5f5f7]">{m.percent}%</b>{m.resets ? ` · ${m.resets}` : ""}
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, m.percent))}%`, background: m.percent >= 80 ? "#ff9f0a" : agentTile(account.agentId) }} />
          </div>
        </div>
      ))}
    </>
  );
}

const CAP = "px-1 pb-2 text-[11px] leading-[14px] uppercase tracking-[0.06em] text-gray-500 dark:text-white/55";
const CARD = "overflow-hidden rounded-xl bg-white shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)] dark:bg-surface dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.05)]";

export function ContasSection() {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const load = useAccountsStore((s) => s.load);
  const [reload, setReload] = useState(0);
  const [focus, setFocus] = useState<AccountsSection | null>(null);
  const manager = useRef<HTMLDivElement>(null);

  useEffect(() => { load().catch(() => undefined); }, [load]);

  // As conectadas: as principais (as que já existiam no sistema) com login, mais as criadas aqui.
  const rows = useMemo(() => [...systemAccounts.filter((a) => a.loggedIn), ...accounts], [systemAccounts, accounts]);

  const manage = useCallback((account: AgentAccount) => {
    setFocus({ kind: "agent", id: account.agentId });
    requestAnimationFrame(() => manager.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  return (
    <SettingsSection title={t("settings.accounts")} description={t("settings.accounts.desc")}>
      <section aria-label={t("settings.accounts.connected")}>
        <h4 className={CAP}>{t("settings.accounts.connected")}</h4>
        <div className={CARD}>
          {rows.length === 0
            ? <p className="px-4 py-5 text-[12.5px] text-gray-400 dark:text-white/35">{t("settings.accounts.noneConnected")}</p>
            : rows.map((a, i) => <AccountRow key={a.id} account={a} first={i === 0} reload={reload} onManage={manage} />)}
        </div>
      </section>

      <section aria-label={t("settings.accounts.usage")}>
        <div className="flex items-end justify-between">
          <h4 className={CAP}>{t("settings.accounts.usage")}</h4>
          <button type="button" onClick={() => setReload((n) => n + 1)} title={t("accounts.plan.refresh")}
            className="mb-1.5 h-6 rounded-md px-2 text-[12px] font-medium text-accent-600 hover:bg-accent-500/10 dark:text-accent-400">{t("accounts.plan.refresh")}</button>
        </div>
        <div className={CARD}><UsageBlock accounts={rows} reload={reload} /></div>
      </section>

      <section aria-label={t("settings.accounts.prefs")}>
        <h4 className={CAP}>{t("settings.accounts.prefs")}</h4>
        <SettingsGroup>
          <NotificationsSetting />
          <SettingsRow label={t("settings.accounts.pools")} hint={t("settings.accounts.poolsHint")}>
            <button type="button" onClick={() => { const first = rows[0] ?? systemAccounts[0]; if (first) manage(first); }}
              className="h-7 rounded-[7px] bg-black/[0.06] px-3 text-[13px] font-medium text-gray-900 hover:bg-black/[0.09] dark:bg-surface-overlay dark:text-[#f5f5f7] dark:hover:brightness-110">
              {t("settings.accounts.configure")}
            </button>
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section ref={manager} aria-label={t("settings.accounts.manager")} className="scroll-mt-4">
        <h4 className={CAP}>{t("settings.accounts.manager")}</h4>
        <AccountsManager focus={focus} />
      </section>
    </SettingsSection>
  );
}
