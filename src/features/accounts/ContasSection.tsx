import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { PanelBoundary } from "@/app/PanelBoundary";
import { agentIcon } from "@/features/agents/agentIcons";
import { AddGitAccountDialog } from "@/features/forge/AddGitAccountDialog";
import { ForgeIcon, forgeLabel } from "@/features/forge/forgeMeta";
import { useForgeStore } from "@/features/forge/store";
import type { GitAccount } from "@/features/forge/types";
import { AlertaToast } from "@/shared/ui/alerts";
import { AppDialog } from "@/shared/ui/AppDialog";

import { AccountIdentityDialog } from "./AccountIdentityDialog";
import { AddAccountDialog } from "./AddAccountDialog";
import { accountBadgeStyle, accountDisplayLabel, accountInitials } from "./accountIdentity";
import { accountLimitsGet, accountLimitsSet, antigravityCliUsage, codexAccountUsage, type AgyGroup, type AgyWindow } from "./ipc";
import { loadLimitsFor, parseLimitsForm, type LimitsLoad } from "./limits";
import { meterTone } from "./meter";
import { usePools } from "./pools";
import { isPrimaryAccount, loadPrimaryAccount, savePrimaryAccount, sortWithPrimaryFirst } from "./primary";
import { useAccountsStore } from "./store";
import type { AgentAccount } from "./types";
import { agentAccountUsage, claudeLiveUsage, formatRemaining, humanPlan } from "./usage";

const GIT_TAB = "git";

/** Um perfil sintético (`system:*`) não tem linha no banco: para o backend é `null`. */
const realId = (a: AgentAccount) => (a.id.startsWith("system:") ? null : a.id);

interface Meter { key: string; label: string; percent: number; resets: string | null }
interface AccountInfo {
  plan: string | null;
  meters: Meter[];
  agyGroups: AgyGroup[] | null;
  fetchedAt: number | null;
}

type Translate = (key: string, vars?: Record<string, unknown>) => string;

function formatResetIso(iso: string | undefined, kind: AgyWindow["kind"], language: string, t: Translate): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const now = Math.floor(Date.now() / 1000);
  const epoch = Math.floor(ms / 1000);
  if (epoch <= now) return t("chat.summary.limits.renewed");
  const left = epoch - now;
  if (kind === "session" && left < 24 * 3600) return formatRemaining(left);
  return new Intl.DateTimeFormat(language, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

/** O plano e as cotas de uma conta (Claude, Codex ou grupos de modelos do Antigravity). */
async function fetchInfo(account: AgentAccount, force: boolean, t: Translate): Promise<AccountInfo> {
  const meters: Meter[] = [];
  let plan: string | null = null;
  let agyGroups: AgyGroup[] | null = null;
  let fetchedAt: number | null = null;

  if (account.agentId === "claude-code") {
    const usage = await agentAccountUsage(account.agentId, realId(account)).catch(() => null);
    if (usage) plan = humanPlan(usage.plan.tier);
    const live = await claudeLiveUsage(account.id, force);
    if (live.fetchedAt > 0) fetchedAt = live.fetchedAt;
    if (live.available && live.session) {
      meters.push({ key: "session", label: t("chat.accounts.window"), percent: live.session.percent, resets: live.session.resets });
    }
    if (live.available && live.week) {
      meters.push({ key: "week", label: t("chat.accounts.week"), percent: live.week.percent, resets: live.week.resets });
    }
  } else if (account.agentId === "codex") {
    const usage = await codexAccountUsage(account.id, force);
    if (usage.fetchedAt > 0) fetchedAt = usage.fetchedAt;
    const now = Date.now() / 1000;
    const when = (at: number | null) => (at ? t("settings.accounts.resetsIn", { time: formatRemaining(at - now) }) : null);
    if (usage.quota?.fiveHour) {
      meters.push({ key: "5h", label: t("chat.accounts.window"), percent: Math.round(usage.quota.fiveHour.utilization * 100), resets: when(usage.quota.fiveHour.resetsAt) });
    }
    if (usage.quota?.sevenDay) {
      meters.push({ key: "7d", label: t("chat.accounts.week"), percent: Math.round(usage.quota.sevenDay.utilization * 100), resets: when(usage.quota.sevenDay.resetsAt) });
    }
    plan = usage.plan ?? null;
  } else if (account.agentId === "antigravity") {
    let usage = await antigravityCliUsage(force, realId(account)).catch(() => null);
    // Sem `force` o backend só devolve o que está guardado; na primeira vez não há nada.
    // Como no painel do chat (usageStore), cache vazio vira leitura de verdade.
    if (!force && usage?.installed && usage.groups.length === 0) {
      usage = await antigravityCliUsage(true, realId(account)).catch(() => null);
    }
    if (usage && usage.installed && usage.groups.length > 0) {
      agyGroups = usage.groups;
      if (usage.fetchedAt > 0) fetchedAt = usage.fetchedAt;
    }
  }
  return { plan, meters, agyGroups, fetchedAt };
}

function useAccountInfo(account: AgentAccount, reload: number): AccountInfo & { loading: boolean } {
  const { t, i18n } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [info, setInfo] = useState<AccountInfo & { loading: boolean }>({
    plan: null, meters: [], agyGroups: null, fetchedAt: null, loading: true,
  });
  useEffect(() => {
    if (!account.loggedIn || account.kind === "api_key") {
      setInfo((cur) => (
        !cur.loading && cur.plan === null && cur.meters.length === 0 && cur.agyGroups === null
          ? cur
          : { plan: null, meters: [], agyGroups: null, fetchedAt: null, loading: false }
      ));
      return;
    }
    let stale = false;
    setInfo((cur) => ({ ...cur, loading: true }));
    fetchInfo(account, reload > 0, tRef.current as Translate)
      .catch(() => ({ plan: null, meters: [], agyGroups: null, fetchedAt: null }))
      .then((res) => { if (!stale) setInfo({ ...res, loading: false }); });
    return () => { stale = true; };
  }, [account.id, account.agentId, account.loggedIn, account.kind, reload, i18n.language]);
  return info;
}

/** Diálogo "Limites desta conta": tarefas simultâneas + gasto máximo por dia. */
function AccountLimitsDialog({ account, onClose }: { account: AgentAccount; onClose: () => void }) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<LimitsLoad>({ status: "loading" });
  const [concurrent, setConcurrent] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    loadLimitsFor(account.id, accountLimitsGet).then((next) => {
      if (stale) return;
      setLoad(next);
      if (next.status === "ready") {
        setConcurrent(next.limits.maxConcurrent?.toString() ?? "");
        setBudget(next.limits.dailyBudgetUsd?.toString() ?? "");
      }
    });
    return () => { stale = true; };
  }, [account.id]);

  const save = async () => {
    const parsed = parseLimitsForm(load, concurrent, budget);
    if (!parsed.ok) {
      if (parsed.problem === "maxConcurrent") setError(t("settings.accounts.limits.maxConcurrentHelper"));
      if (parsed.problem === "budget") setError(t("settings.accounts.limits.budgetInvalid"));
      return;
    }
    setBusy(true);
    try {
      await accountLimitsSet(account.id, parsed.limits);
      AlertaToast(t("settings.accounts.limits.btn"), t("settings.accounts.limits.saved"), "success", 3500);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("settings.accounts.limits.title", { name: accountDisplayLabel(account, t("accounts.principalName")) })}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy || load.status !== "ready"} onClick={() => void save()}>
            {t("settings.accounts.limits.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label={t("settings.accounts.limits.maxConcurrent")}
          type="number"
          min={1}
          step={1}
          value={concurrent}
          disabled={load.status !== "ready"}
          onChange={(e) => { setConcurrent(e.target.value); setError(""); }}
          placeholder={t("settings.accounts.limits.unlimited")}
          variant="outline"
        />
        <Input
          label={t("settings.accounts.limits.budget")}
          type="number"
          min={0}
          step={0.5}
          value={budget}
          disabled={load.status !== "ready"}
          onChange={(e) => { setBudget(e.target.value); setError(""); }}
          placeholder={t("settings.accounts.limits.unlimited")}
          variant="outline"
        />
        <p className="m-0 text-[11.5px] text-gray-400 dark:text-white/40">{t("settings.accounts.limits.backgroundHint")}</p>
        {load.status === "loading" && <p className="m-0 text-[11.5px] text-gray-500 dark:text-white/45">{t("settings.accounts.limits.loading")}</p>}
        {load.status === "error" && <p role="alert" className="m-0 text-[11.5px] text-red-500 dark:text-red-400">{t("settings.accounts.limits.loadError", { error: load.message })}</p>}
        {error && <p role="alert" className="m-0 text-[11.5px] text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </AppDialog>
  );
}

/** Diálogo de remoção de conta com escolha rádio (Manter arquivos / Apagar pasta do perfil). */
function RemoveAccountDialog({ account, onClose, onConfirm }: {
  account: AgentAccount;
  onClose: () => void;
  onConfirm: (deleteFiles: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = accountDisplayLabel(account, t("accounts.principalName"));

  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(deleteFiles); } finally { setBusy(false); }
  };

  return (
    <AppDialog
      title={t("settings.accounts.delete.title", { name })}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void confirm()}>{t("providers.account.remove")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[12.5px] text-gray-600 dark:text-white/65">{t("settings.accounts.delete.body")}</p>
        <div role="radiogroup" className="flex flex-col gap-1.5">
          {[
            { value: false, label: t("settings.accounts.delete.keepFiles") },
            { value: true, label: t("settings.accounts.delete.withFiles") },
          ].map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              role="radio"
              aria-checked={deleteFiles === opt.value}
              onClick={() => setDeleteFiles(opt.value)}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12.5px] font-medium transition-colors
                ${deleteFiles === opt.value
                  ? "border-accent-500 bg-accent-500/8 dark:bg-accent-500/12 text-gray-900 dark:text-white"
                  : "border-gray-200 dark:border-white/[0.08] text-gray-700 dark:text-white/75"}`}
            >
              <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${deleteFiles === opt.value ? "border-accent-500" : "border-gray-300 dark:border-white/25"}`}>
                {deleteFiles === opt.value && <span className="h-2 w-2 rounded-full bg-accent-500" />}
              </span>
              {opt.label}
            </button>
          ))}
        </div>
        <code className="block text-[11px] font-mono break-all text-gray-400 dark:text-white/40">{account.dir}</code>
      </div>
    </AppDialog>
  );
}

export interface ContasSectionProps {
  /** Provedor inicial selecionado (ex.: vindo de "Gerenciar em Contas ›"). */
  initialProvider?: string | null;
  /** Troca para a aba Pools. */
  onOpenPools?: () => void;
}

/**
 * Aba Contas — o ÚNICO lugar para gerenciar contas (agentes e Git):
 * - sub-abas de provedor com contador simples + aba Git;
 * - um cartão por conta, sem badges (estado no ponto do avatar, "Principal" no subtítulo);
 * - cotas inline (tabela por grupo de modelos no Antigravity);
 * - botão "Entrar" só quando o login expirou;
 * - menu ⋯ com todas as ações;
 * - linha de resumo de pools + link "Ver pools".
 */
export function ContasSection({ initialProvider = null, onOpenPools }: ContasSectionProps = {}) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const capable = useAccountsStore((s) => s.capable);
  const accountsLoaded = useAccountsStore((s) => s.loaded);
  const loadAccounts = useAccountsStore((s) => s.load);
  const removeAccount = useAccountsStore((s) => s.remove);
  const gitAccounts = useForgeStore((s) => s.accounts) ?? [];
  const gitLoaded = useForgeStore((s) => s.loaded);
  const loadGit = useForgeStore((s) => s.load);
  const removeGit = useForgeStore((s) => s.remove);
  const pools = usePools();

  const [picked, setPicked] = useState<string | null>(initialProvider);
  const [reload, setReload] = useState(0);
  const [addingAgent, setAddingAgent] = useState<string | null>(null);
  const [reloginFor, setReloginFor] = useState<AgentAccount | null>(null);
  const [identityFor, setIdentityFor] = useState<AgentAccount | null>(null);
  const [limitsFor, setLimitsFor] = useState<AgentAccount | null>(null);
  const [removingFor, setRemovingFor] = useState<AgentAccount | null>(null);
  const [addingGit, setAddingGit] = useState<{ kind: GitAccount["kind"] | null; host?: string } | null>(null);
  const [removingGit, setRemovingGit] = useState<GitAccount | null>(null);
  const [primaryByAgent, setPrimaryByAgent] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (initialProvider) setPicked(initialProvider);
  }, [initialProvider]);

  useEffect(() => {
    if (!accountsLoaded) loadAccounts().catch(() => undefined);
    if (!gitLoaded) loadGit().catch(() => undefined);
  }, [accountsLoaded, gitLoaded, loadAccounts, loadGit]);

  const activeTab = picked ?? capable[0]?.agentId ?? GIT_TAB;
  const isGit = activeTab === GIT_TAB;
  const agent = isGit ? null : (capable.find((c) => c.agentId === activeTab) ?? capable[0] ?? null);

  useEffect(() => {
    if (!agent) return;
    let stale = false;
    loadPrimaryAccount(agent.agentId).then((id) => {
      if (!stale) setPrimaryByAgent((prev) => ({ ...prev, [agent.agentId]: id }));
    });
    return () => { stale = true; };
  }, [agent?.agentId]);

  const countFor = useCallback(
    (agentId: string) => [...systemAccounts, ...accounts].filter((a) => a.agentId === agentId).length,
    [systemAccounts, accounts],
  );

  const primaryId = agent ? (primaryByAgent[agent.agentId] ?? null) : null;
  const rows = useMemo(() => {
    if (!agent) return [];
    const list = [...systemAccounts, ...accounts].filter((a) => a.agentId === agent.agentId);
    return sortWithPrimaryFirst(list, primaryId);
  }, [systemAccounts, accounts, agent, primaryId]);

  const agentPools = useMemo(
    () => (agent ? pools.filter((p) => p.agentId === agent.agentId) : []),
    [pools, agent],
  );

  const accountNameById = useCallback((id: string | null) => {
    if (!agent) return "?";
    if (id === null) {
      const sys = systemAccounts.find((a) => a.agentId === agent.agentId);
      return sys ? accountDisplayLabel(sys, t("accounts.principalName")) : t("accounts.principalName");
    }
    const found = accounts.find((a) => a.id === id);
    return found ? accountDisplayLabel(found, t("accounts.principalName")) : id;
  }, [agent, systemAccounts, accounts, t]);

  const makePrimary = async (account: AgentAccount) => {
    try {
      await savePrimaryAccount(account.agentId, account.id);
      setPrimaryByAgent((prev) => ({ ...prev, [account.agentId]: account.id }));
      AlertaToast(
        t("settings.accounts"),
        t("settings.accounts.menu.madePrimary", { name: accountDisplayLabel(account, t("accounts.principalName")) }),
        "success",
        3500,
      );
    } catch (e) {
      AlertaToast(t("settings.accounts"), String(e), "error", 6000);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Sub-abas de provedor + separador + Git */}
      <nav role="tablist" aria-label={t("settings.agents")} className="flex flex-wrap items-center gap-1 border-b border-gray-200 dark:border-white/[0.08]">
        {capable.map((c) => {
          const Icon = agentIcon(c.agentId, c.label);
          const on = !isGit && agent?.agentId === c.agentId;
          const n = countFor(c.agentId);
          return (
            <button
              key={c.agentId}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setPicked(c.agentId)}
              className={`inline-flex items-center gap-1.5 px-2.5 pt-2 pb-2.5 -mb-px border-b-2 text-[13px] transition-colors
                ${on
                  ? "border-gray-900 dark:border-white text-gray-900 dark:text-white font-medium"
                  : "border-transparent text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{c.label}</span>
              <span className="text-[12px] text-gray-400 dark:text-white/40 tabular-nums">{n}</span>
            </button>
          );
        })}

        <span aria-hidden="true" className="w-px h-4 mx-1.5 bg-gray-200 dark:bg-white/10" />

        <button
          type="button"
          role="tab"
          aria-selected={isGit}
          onClick={() => setPicked(GIT_TAB)}
          className={`inline-flex items-center gap-1.5 px-2.5 pt-2 pb-2.5 -mb-px border-b-2 text-[13px] transition-colors
            ${isGit
              ? "border-gray-900 dark:border-white text-gray-900 dark:text-white font-medium"
              : "border-transparent text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}
        >
          <ForgeIcon kind="github" className="w-4 h-4 shrink-0" />
          <span>{t("accounts.group.git")}</span>
          <span className="text-[12px] text-gray-400 dark:text-white/40 tabular-nums">{gitAccounts.length}</span>
        </button>
      </nav>

      {/* Conteúdo: Git */}
      {isGit ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[13px] text-gray-500 dark:text-white/50">{t("settings.accounts.git.desc")}</span>
            <Button variant="primary" size="sm" onClick={() => setAddingGit({ kind: null })}>
              + {t("settings.accounts.git.connect")}
            </Button>
          </div>

          {gitAccounts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-6 py-9 text-center">
              <b className="text-[13.5px] font-semibold text-gray-900 dark:text-white">{t("settings.accounts.git.emptyTitle")}</b>
              <p className="m-0 text-[12px] text-gray-500 dark:text-white/50">{t("settings.accounts.git.emptyDesc")}</p>
              <Button variant="primary" size="sm" className="mt-1" onClick={() => setAddingGit({ kind: null })}>
                + {t("settings.accounts.git.connect")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {gitAccounts.map((g) => (
                <GitAccountCard
                  key={g.id}
                  account={g}
                  onVerify={() => {
                    loadGit()
                      .then(() => AlertaToast(g.login, t("settings.accounts.menu.verifiedOk", { name: g.login }), "success", 3000))
                      .catch((e) => AlertaToast(g.login, String(e), "error", 5000));
                  }}
                  onReplaceToken={() => setAddingGit({ kind: g.kind, host: g.host })}
                  onRemove={() => setRemovingGit(g)}
                />
              ))}
            </div>
          )}
        </div>
      ) : agent ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[13px] text-gray-500 dark:text-white/50">
              {rows.length > 0 ? t("providers.agents.accountsCount", { count: rows.length }) : ""}
            </span>
            {rows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReload((n) => n + 1);
                  AlertaToast(t("settings.accounts"), t("settings.accounts.quotasRefreshed"), "success", 2500);
                }}
              >
                ↻ {t("accounts.plan.refresh")}
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => setAddingAgent(agent.agentId)}>
              + {t("settings.accounts.add")}
            </Button>
          </div>

          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-6 py-9 text-center">
              <b className="text-[13.5px] font-semibold text-gray-900 dark:text-white">
                {t("settings.accounts.emptyForProvider", { provider: agent.label })}
              </b>
              <p className="m-0 text-[12px] text-gray-500 dark:text-white/50">
                {t("settings.accounts.emptyForProviderDesc", { provider: agent.label })}
              </p>
              <Button variant="primary" size="sm" className="mt-1" onClick={() => setAddingAgent(agent.agentId)}>
                + {t("settings.accounts.add")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {rows.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  isMain={isPrimaryAccount(account, primaryId)}
                  reload={reload}
                  onLogin={() => setReloginFor(account)}
                  onRename={() => setIdentityFor(account)}
                  onLimits={() => setLimitsFor(account)}
                  onMakePrimary={() => void makePrimary(account)}
                  onRemove={account.id.startsWith("system:") ? undefined : () => setRemovingFor(account)}
                />
              ))}
            </div>
          )}

          {agentPools.length > 0 && (
            <p className="m-0 mx-0.5 text-[12px] text-gray-500 dark:text-white/45">
              ⇄{" "}
              {agentPools.map((pool, i) => (
                <span key={pool.id}>
                  {i > 0 ? " · " : ""}
                  {t("settings.accounts.poolLine", {
                    name: pool.name,
                    members: pool.members.map(accountNameById).join(", "),
                  })}
                </span>
              ))}
              {" · "}
              <button
                type="button"
                onClick={() => onOpenPools?.()}
                className="font-medium text-accent-600 dark:text-accent-400 hover:underline"
              >
                {t("settings.accounts.viewPools")}
              </button>
            </p>
          )}

          <p className="m-0 mx-0.5 text-[12px] text-gray-400 dark:text-white/40">
            ⓘ {t("settings.accounts.primaryFootNote")}
          </p>
        </div>
      ) : null}

      {/* Diálogos irmãos do conteúdo (preserva PTY do terminal de login em fronteira própria) */}
      {addingAgent && (
        <PanelBoundary name="adicionar-conta">
          <AddAccountDialog
            agentId={addingAgent}
            allowProviderPick
            onClose={() => setAddingAgent(null)}
          />
        </PanelBoundary>
      )}

      {reloginFor && (
        <PanelBoundary name="relogin-conta">
          <AddAccountDialog
            agentId={reloginFor.agentId}
            reloginAccount={reloginFor}
            onClose={() => setReloginFor(null)}
          />
        </PanelBoundary>
      )}

      {identityFor && (
        <AccountIdentityDialog account={identityFor} onClose={() => setIdentityFor(null)} />
      )}

      {limitsFor && (
        <AccountLimitsDialog account={limitsFor} onClose={() => setLimitsFor(null)} />
      )}

      {removingFor && (
        <RemoveAccountDialog
          account={removingFor}
          onClose={() => setRemovingFor(null)}
          onConfirm={async (deleteFiles) => {
            try {
              await removeAccount(removingFor.id, deleteFiles);
              AlertaToast(t("settings.accounts"), t("settings.accounts.removed", { name: removingFor.name }), "success", 3500);
            } catch (e) {
              AlertaToast(t("settings.accounts"), String(e), "error", 6000);
            } finally {
              setRemovingFor(null);
            }
          }}
        />
      )}

      {addingGit && (
        <AddGitAccountDialog
          kind={addingGit.kind}
          host={addingGit.host}
          onClose={() => setAddingGit(null)}
        />
      )}

      {removingGit && (
        <AppDialog
          title={t("forge.signOut.title", { login: removingGit.login, host: removingGit.host })}
          onClose={() => setRemovingGit(null)}
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setRemovingGit(null)}>{t("btn.cancel")}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  removeGit(removingGit.id)
                    .catch((e) => AlertaToast(removingGit.login, String(e), "error", 6000))
                    .finally(() => setRemovingGit(null));
                }}
              >
                {t("forge.signOut")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-[13px] text-gray-600 dark:text-white/65">{t("forge.signOut.body")}</p>
        </AppDialog>
      )}
    </div>
  );
}

/** Menu ⋯ acessível com fechamento ao clicar fora ou apertar Escape. */
function OverflowMenu({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-[16px] leading-none transition-colors
          ${open
            ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white"
            : "text-gray-400 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white"}`}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-30 w-60 rounded-xl border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-surface-raised p-1.5 shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, danger = false, onClick }: {
  icon: string;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06]
        ${danger ? "text-red-600 dark:text-red-400" : "text-gray-800 dark:text-gray-100"}`}
    >
      <span aria-hidden="true" className="w-4 shrink-0 text-center opacity-75">{icon}</span>
      <span className="flex flex-col min-w-0">
        <span>{label}</span>
        {hint && <small className="text-[11px] text-gray-400 dark:text-white/40">{hint}</small>}
      </span>
    </button>
  );
}

function AccountCard({ account, isMain, reload, onLogin, onRename, onLimits, onMakePrimary, onRemove }: {
  account: AgentAccount;
  isMain: boolean;
  reload: number;
  onLogin: () => void;
  onRename: () => void;
  onLimits: () => void;
  onMakePrimary: () => void;
  onRemove?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const health = useAccountsStore((s) => s.health[account.id]);
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const { plan, meters, agyGroups } = useAccountInfo(account, reload);

  const verified = health && health !== "checking" ? health : null;
  const ok = verified?.status === "ok"
    ? true
    : verified?.status === "invalid" || verified?.status === "not_logged_in"
      ? false
      : account.loggedIn;

  const displayName = accountDisplayLabel(account, t("accounts.principalName"));
  const badgeStyle = accountBadgeStyle(account.accentColor);
  const byKey = account.kind === "api_key";

  const detailParts: string[] = [];
  // O nome "Principal" já diz que é a principal: repetir "conta principal" embaixo não informa nada.
  if (isMain && displayName !== t("accounts.principalName")) detailParts.push(t("chat.accounts.main"));
  if (byKey) {
    detailParts.push(account.baseUrl ? `${t("accounts.kind.apiKey")} · ${account.baseUrl}` : t("accounts.kind.apiKey"));
  } else {
    const email = verified?.email ?? account.label;
    if (email) detailParts.push(email);
    const planText = verified?.plan ?? plan;
    if (planText) detailParts.push(planText);
  }
  // Sem e-mail nem plano ainda (não verificada): diz de onde a conta vem.
  if (detailParts.length === 0 && account.id.startsWith("system:")) detailParts.push(t("providers.account.system"));

  const verify = async () => {
    const res = await checkHealth(account.id);
    if (res.status === "ok") {
      AlertaToast(displayName, t("settings.accounts.menu.verifiedOk", { name: displayName }), "success", 3500);
    } else {
      AlertaToast(displayName, res.detail || t("settings.accounts.menu.verifiedExpired", { name: displayName }), "warning", 5000);
    }
  };

  const copyDir = () => {
    navigator.clipboard?.writeText(account.dir)
      .then(() => AlertaToast(displayName, t("settings.accounts.menu.copiedPath"), "success", 2500))
      .catch(() => AlertaToast(displayName, account.dir, "info", 4000));
  };

  return (
    <div
      data-account-card={account.id}
      className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-4 py-3.5"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          style={badgeStyle}
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold select-none
            ${badgeStyle ? "" : "bg-gray-200 text-gray-700 dark:bg-white/12 dark:text-white"}`}
        >
          {accountInitials(displayName)}
          <span
            className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-surface
              ${ok ? "bg-emerald-500" : "bg-gray-400 dark:bg-white/35"}`}
          />
        </span>

        <div className="flex-1 min-w-0">
          <div className="truncate text-[14px] font-semibold text-gray-900 dark:text-white">{displayName}</div>
          <div className="truncate text-[12px] text-gray-400 dark:text-white/45">
            {ok ? (
              detailParts.join(" · ") || t("settings.accounts.loggedIn")
            ) : (
              <span className="text-amber-700 dark:text-amber-400">{t("settings.accounts.expiredHint")}</span>
            )}
          </div>
        </div>

        {!ok && !byKey && (
          <Button variant="primary" size="sm" onClick={onLogin}>
            {t("providers.account.signIn")}
          </Button>
        )}

        <OverflowMenu label={t("settings.accounts.menu.more", { name: displayName })}>
          {(close) => (
            <>
              <MenuItem
                icon="✓"
                label={t("settings.accounts.menu.verify")}
                hint={t("settings.accounts.menu.verifyHint")}
                onClick={() => { close(); void verify(); }}
              />
              {!byKey && (
                <MenuItem
                  icon="↻"
                  label={t("settings.accounts.relogin")}
                  onClick={() => { close(); onLogin(); }}
                />
              )}
              <MenuItem
                icon="✎"
                label={t("settings.accounts.menu.nameColor")}
                onClick={() => { close(); onRename(); }}
              />
              <MenuItem
                icon="⚙︎"
                label={t("settings.accounts.menu.limits")}
                hint={t("settings.accounts.menu.limitsHint")}
                onClick={() => { close(); onLimits(); }}
              />
              {!isMain && (
                <MenuItem
                  icon="★"
                  label={t("settings.accounts.menu.makePrimary")}
                  onClick={() => { close(); onMakePrimary(); }}
                />
              )}
              <hr className="my-1 border-0 border-t border-gray-200 dark:border-white/[0.08]" />
              <MenuItem
                icon="⧉"
                label={t("settings.accounts.menu.copyPath")}
                onClick={() => { close(); copyDir(); }}
              />
              {onRemove && (
                <MenuItem
                  icon="🗑"
                  label={t("settings.accounts.menu.remove")}
                  danger
                  onClick={() => { close(); onRemove(); }}
                />
              )}
            </>
          )}
        </OverflowMenu>
      </div>

      {/* Cotas: tabela por grupo de modelos (Antigravity) ou 2 colunas (Claude/Codex) */}
      {ok && agyGroups && agyGroups.length > 0 && (
        <div className="mt-3 pt-3 border-t border-dashed border-gray-200 dark:border-white/[0.08]">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-gray-400 dark:text-white/40">
                <th className="pb-1.5 font-medium w-[30%]">{t("settings.accounts.quota.models")}</th>
                <th className="pb-1.5 font-medium">{t("settings.accounts.quota.window5h")}</th>
                <th className="pb-1.5 font-medium">{t("settings.accounts.quota.thisWeek")}</th>
              </tr>
            </thead>
            <tbody>
              {agyGroups.map((group) => {
                const session = group.windows.find((w) => w.kind === "session");
                const weekly = group.windows.find((w) => w.kind === "weekly") ?? group.windows.find((w) => w.kind !== "session");
                return (
                  <tr key={group.name}>
                    <td className="py-1.5 pr-3 text-gray-700 dark:text-white/80">{group.name}</td>
                    <td className="py-1.5 pr-4">
                      {session ? (
                        <QuotaCell
                          percent={Math.round(session.usedPct)}
                          reset={formatResetIso(session.resetsAt, session.kind, i18n.language, t as Translate)}
                        />
                      ) : (
                        <span className="text-gray-400 dark:text-white/35">—</span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {weekly ? (
                        <QuotaCell
                          percent={Math.round(weekly.usedPct)}
                          reset={formatResetIso(weekly.resetsAt, weekly.kind, i18n.language, t as Translate)}
                        />
                      ) : (
                        <span className="text-gray-400 dark:text-white/35">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {ok && !agyGroups && meters.length > 0 && (
        <div className="mt-3 pt-3 border-t border-dashed border-gray-200 dark:border-white/[0.08] grid grid-cols-1 sm:grid-cols-2 gap-4">
          {meters.map((m) => (
            <div key={m.key} className="flex flex-col gap-1">
              <div className="flex justify-between text-[12px]">
                <span className="font-medium text-gray-700 dark:text-white/80">
                  {m.key === "session" || m.key === "5h" ? t("settings.accounts.quota.window5h") : t("settings.accounts.quota.thisWeek")}
                </span>
                <span className="font-mono tabular-nums text-gray-700 dark:text-white/80">{m.percent}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                <div className={`h-full rounded-full ${meterTone(m.percent)}`} style={{ width: `${Math.min(100, Math.max(0, m.percent))}%` }} />
              </div>
              {m.resets && <span className="text-[11px] text-gray-400 dark:text-white/40">{m.resets}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuotaCell({ percent, reset }: { percent: number; reset: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${meterTone(clamped)}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="w-8 text-right font-mono tabular-nums text-gray-700 dark:text-white/80">{clamped}%</span>
      {reset && <span className="w-20 truncate text-[11px] text-gray-400 dark:text-white/40">{reset}</span>}
    </div>
  );
}

function GitAccountCard({ account, onVerify, onReplaceToken, onRemove }: {
  account: GitAccount;
  onVerify: () => void;
  onReplaceToken: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const provider = forgeLabel(account.kind, t);
  const authText = account.auth === "oauth" ? t("forge.auth.oauth") : t("settings.accounts.git.tokenKeychain");
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-4 py-3.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-white/[0.08] text-gray-800 dark:text-white">
        <ForgeIcon kind={account.kind} className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[14px] font-semibold text-gray-900 dark:text-white">{account.login}</div>
        <div className="truncate text-[12px] text-gray-400 dark:text-white/45">
          {provider} · {authText}
        </div>
      </div>
      <OverflowMenu label={t("settings.accounts.menu.more", { name: account.login })}>
        {(close) => (
          <>
            <MenuItem icon="✓" label={t("settings.accounts.menu.verify")} onClick={() => { close(); onVerify(); }} />
            <MenuItem icon="↻" label={t("settings.accounts.git.replaceToken")} onClick={() => { close(); onReplaceToken(); }} />
            <hr className="my-1 border-0 border-t border-gray-200 dark:border-white/[0.08]" />
            <MenuItem icon="🗑" label={t("forge.signOut")} danger onClick={() => { close(); onRemove(); }} />
          </>
        )}
      </OverflowMenu>
    </div>
  );
}
