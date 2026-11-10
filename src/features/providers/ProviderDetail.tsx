import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { hasUpdate, type AgentUpdateInfo } from "@/features/agents/updatePolicy";
import { installRowState, type AgentInstallOffer } from "@/features/agents/installPolicy";
import { agentIcon } from "@/features/agents/agentIcons";
import { reasonText, runAgentUpdate } from "@/features/agents/AgentUpdateWatcher";
import { agentInstall, agentInstallOffers, agentUpdatesCheck, detectAgents } from "@/features/agents/ipc";
import { ChatSwitch, SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";
import { AlertaToast } from "@/shared/ui/alerts";
import { AppDialog } from "@/shared/ui/AppDialog";

import { accountIdentity, providerStatus, signInMethods, versionLabel, type SignInMethodId } from "./providersModel";
import { useProvidersStore } from "./store";

/** Uma conta do provedor: quem é, se tem login e o que se pode fazer (verificar, entrar de novo, remover). */
function AccountLine({ account, onLogin, onRemove }: {
  account: AgentAccount;
  onLogin: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const health = useAccountsStore((s) => s.health[account.id]);
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const checking = health === "checking";
  const system = account.id.startsWith("system:");
  const byKey = account.kind === "api_key";
  const known = health && health !== "checking" ? health : null;
  const ok = known ? known.status === "ok" || (known.status === "unknown" && account.loggedIn) : account.loggedIn;
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="flex items-center gap-2 min-w-0">
          <b className="truncate text-[14px] font-medium text-gray-900 dark:text-white">{account.name}</b>
          {system && <span className="shrink-0 text-[11px] px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">{t("providers.account.system")}</span>}
          {byKey && <span className="shrink-0 text-[11px] px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">API key</span>}
        </span>
        <span title={`${account.envVar}=${account.dir}`} className="truncate text-[12.5px] text-gray-500 dark:text-white/50">
          {checking ? t("settings.accounts.health.checking") : ok ? accountIdentity(account, health) : t("settings.accounts.pendingLogin")}
          {known && known.status !== "ok" && known.detail ? ` · ${known.detail}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button variant="outline" size="sm" disabled={checking} onClick={() => void checkHealth(account.id)}>{t("settings.accounts.health.check")}</Button>
        {!byKey && <Button variant={ok ? "outline" : "primary"} size="sm" onClick={onLogin}>{ok ? t("providers.account.change") : t("providers.account.signIn")}</Button>}
        {onRemove && <Button variant="outline" size="sm" onClick={onRemove}>{t("providers.account.remove")}</Button>}
      </div>
    </div>
  );
}

/**
 * O detalhe de um provedor (T3: Status, Setup, Account, Runtime). Tudo o que muda credencial passa pelo
 * fluxo oficial da CLI, num terminal (`LoginTerminal`), ou pela chave de API no chaveiro do SO
 * (`AddAccountDialog`): a ADE nunca lê nem guarda senha ou token.
 */
export function ProviderDetail({ agent, onBack }: { agent: AgentInfo; onBack: () => void }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const capable = useAccountsStore((s) => s.capable);
  const health = useAccountsStore((s) => s.health);
  const load = useAccountsStore((s) => s.load);
  const remove = useAccountsStore((s) => s.remove);
  const disabled = useProvidersStore((s) => s.disabled);
  const setEnabled = useProvidersStore((s) => s.setEnabled);
  const setDetectedAgents = useTabsStore((s) => s.setDetectedAgents);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);

  const [offer, setOffer] = useState<AgentInstallOffer | undefined>();
  const [update, setUpdate] = useState<AgentUpdateInfo | undefined>();
  const [busy, setBusy] = useState<"install" | "update" | null>(null);
  const [method, setMethod] = useState<SignInMethodId>("login");
  const [adding, setAdding] = useState(false);
  const [loginFor, setLoginFor] = useState<AgentAccount | null>(null);
  const [removing, setRemoving] = useState<AgentAccount | null>(null);
  const removingNow = useRef(false);

  const accountCapable = capable.some((c) => c.agentId === agent.id);
  const rows = useMemo(() => [...systemAccounts, ...accounts].filter((a) => a.agentId === agent.id), [systemAccounts, accounts, agent.id]);
  const methods = signInMethods(agent.id, accountCapable);
  const enabled = !disabled.includes(agent.id);
  const Icon = agentIcon(agent.id, agent.label);
  const version = versionLabel(agent.version);
  const status = providerStatus({ installed: agent.available, enabled, supportsAccounts: accountCapable, accounts: rows, health });
  const install = installRowState(agent.available, offer, busy !== null);
  const profileVar = capable.find((c) => c.agentId === agent.id)?.envVar;

  useEffect(() => {
    let stale = false;
    agentInstallOffers().then((list) => { if (!stale) setOffer(list.find((o) => o.agentId === agent.id)); }).catch(() => undefined);
    agentUpdatesCheck().then((list) => { if (!stale) setUpdate(list.find((u) => u.agentId === agent.id)); }).catch(() => undefined);
    return () => { stale = true; };
  }, [agent.id]);

  const runInstall = async () => {
    setBusy("install");
    try {
      const result = await agentInstall(agent.id);
      if (result.ok) {
        AlertaToast(agent.label, t("settings.tuis.install.done", { label: agent.label }), "success", 5000);
        setDetectedAgents(await detectAgents(true));
        await load();
      } else {
        AlertaToast(agent.label, t("settings.tuis.install.failed", { label: agent.label, error: t(`settings.tuis.install.reason.${result.error ?? "failed"}`, { defaultValue: t("settings.tuis.install.reason.failed") }) }), "error", 8000);
      }
    } catch (e) {
      AlertaToast(agent.label, t("settings.tuis.install.failed", { label: agent.label, error: String(e) }), "error", 8000);
    } finally {
      setBusy(null);
    }
  };

  const runUpdate = async (info: AgentUpdateInfo) => {
    setBusy("update");
    try {
      await runAgentUpdate(t, info);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
      agentUpdatesCheck().then((list) => setUpdate(list.find((u) => u.agentId === agent.id))).catch(() => undefined);
    }
  };

  const confirmRemove = async (deleteFiles: boolean) => {
    if (!removing || removingNow.current) return;
    removingNow.current = true;
    try {
      await remove(removing.id, deleteFiles);
    } catch (e) {
      AlertaToast(agent.label, String(e), "error", 6000);
    } finally {
      removingNow.current = false;
      setRemoving(null);
    }
  };

  const chosen = methods.find((m) => m.id === method);
  const addMode = method === "api_key" ? "api_key" : "login";
  const canAdd = accountCapable && agent.available && chosen?.available === true && (method === "login" || method === "api_key");
  const closeLogin = () => { setLoginFor(null); load().catch(() => undefined); };

  return (
    <>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>← {t("providers.back")}</Button>
      </div>
      <div className="flex items-center gap-3 mx-1">
        <Icon className="w-6 h-6 shrink-0 text-gray-700 dark:text-white/70" />
        <h2 className="m-0 flex-1 min-w-0 truncate text-[18px] font-semibold text-gray-900 dark:text-white">
          {agent.label}{version && <span className="ml-2 text-[13px] font-normal text-gray-400 dark:text-white/40">{version}</span>}
        </h2>
        <ChatSwitch label={t("providers.toggle", { name: agent.label })} checked={enabled}
          onChange={(on) => { setEnabled(agent.id, on).catch((e) => AlertaToast(agent.label, String(e), "error", 6000)); }} />
      </div>

      <SettingsSection title={t("providers.detail.status")}>
        <SettingsGroup>
          <SettingsRow label={t("providers.detail.status")} hint={status.tone === "disabled" ? t("providers.disabledNote") : undefined}>
            <span className="text-[13px] text-gray-700 dark:text-white/70">{t(status.key, status.vars)}</span>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("providers.setup.title")}>
        <SettingsGroup>
          <SettingsRow label={t("providers.setup.environment")}><span className="text-[13px] text-gray-700 dark:text-white/70">{t("providers.setup.thisComputer")}</span></SettingsRow>
          <SettingsRow label={t("providers.setup.runtime")} hint={agent.available ? undefined : t("settings.tuis.notFound", { command: agent.command })}>
            <span title={agent.path ?? agent.command} className="max-w-[320px] truncate font-mono text-[12px] text-gray-600 dark:text-white/60">
              {agent.available ? agent.path ?? agent.command : "—"}
            </span>
          </SettingsRow>
          {(install.kind === "button" || (update && hasUpdate(update))) && (
            <div className="flex items-center justify-end gap-2 px-4 py-3">
              {install.kind === "button" && (
                <Button variant="primary" size="sm" disabled={!install.enabled} onClick={() => void runInstall()}>
                  {busy === "install" ? t("settings.tuis.install.running") : t("providers.setup.install")}
                </Button>
              )}
              {update && hasUpdate(update) && (
                <>
                  <span className="text-[12px] text-emerald-600 dark:text-emerald-400">{t("agents.update.latest", { version: update.latestVersion })}</span>
                  <Button variant="outline" size="sm" disabled={busy !== null || update.busy || !update.canAutoUpdate}
                    title={update.reason ? reasonText(t, update.reason) : undefined} onClick={() => void runUpdate(update)}>
                    {busy === "update" ? t("agents.update.running") : t("agents.update.action")}
                  </Button>
                </>
              )}
            </div>
          )}
        </SettingsGroup>
        {install.kind === "manual" && <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">{t("settings.tuis.install.manual", { command: install.command })}</p>}
        {install.kind === "runtime" && <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">{t("settings.tuis.install.runtime")}</p>}
        {install.kind === "app" && <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">{t("settings.tuis.install.app", { command: agent.command })}</p>}
        {agent.available && <p className="m-0 mx-1 text-[12px] text-gray-400 dark:text-white/40">{t("providers.setup.noReinstall")}</p>}
      </SettingsSection>

      {accountCapable && (
        <SettingsSection title={t("providers.account.title")} description={t("providers.account.isolation", { envVar: profileVar ?? "" })}>
          <SettingsGroup>
            {rows.length === 0 && <p className="m-0 px-4 py-5 text-[13px] text-gray-400 dark:text-white/40">{t("settings.accounts.emptyForAgent")}</p>}
            {rows.map((a) => (
              <AccountLine key={a.id} account={a} onLogin={() => setLoginFor(a)} onRemove={a.id.startsWith("system:") ? undefined : () => setRemoving(a)} />
            ))}
          </SettingsGroup>
          {agent.id === "antigravity" && (
            <p role="note" className="m-0 mx-1 text-[12px] text-amber-700 dark:text-amber-400">{t("providers.account.agyNote")}</p>
          )}
          <button type="button" onClick={() => { setSettingsSection("accounts"); }}
            className="self-start mx-1 text-[12px] text-accent-600 dark:text-accent-400 hover:underline">{t("providers.usage.link")}</button>
        </SettingsSection>
      )}

      {methods.length > 0 && (
        <SettingsSection title={t("providers.method.title")}>
          <SettingsGroup>
            <div role="radiogroup" aria-label={t("providers.method.title")} className="flex flex-col divide-y divide-gray-200 dark:divide-white/[0.08]">
              {methods.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={method === m.id} disabled={!m.available}
                  onClick={() => setMethod(m.id)}
                  className="flex items-start gap-3 px-4 py-3 text-left disabled:opacity-60 focus:outline-none focus-visible:bg-gray-50 dark:focus-visible:bg-white/[0.04]">
                  <span aria-hidden="true" className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${method === m.id ? "border-accent-600" : "border-gray-300 dark:border-white/25"}`}>
                    {method === m.id && <span className="h-2 w-2 rounded-full bg-accent-600" />}
                  </span>
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[14px] text-gray-900 dark:text-white">{t(m.labelKey)}</span>
                    {!m.available && m.whyKey && <span className="text-[12.5px] text-gray-500 dark:text-white/50">{t(m.whyKey)}</span>}
                  </span>
                </button>
              ))}
            </div>
          </SettingsGroup>
          {method === "api_key" && <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">{t("providers.method.keyNote")}</p>}
          <div className="flex mx-1">
            <Button variant="primary" size="sm" disabled={!canAdd} onClick={() => setAdding(true)}>{t("providers.account.add")}</Button>
          </div>
        </SettingsSection>
      )}

      {adding && <AddAccountDialog agentId={agent.id} initialMode={addMode} onClose={() => setAdding(false)} />}

      {loginFor && (
        <AppDialog title={t("settings.accounts.login.title", { name: loginFor.name })} onClose={closeLogin} size="lg" closeOnBackdrop={false} closeOnEsc={false}
          footer={<Button variant="primary" onClick={closeLogin}>{t("settings.accounts.login.done")}</Button>}>
          <p className="text-xs text-gray-500 dark:text-white/50 mb-3">{t("settings.accounts.login.helper", { command: loginFor.loginCommand })}</p>
          <LoginTerminal account={loginFor} />
        </AppDialog>
      )}

      {removing && (
        <AppDialog title={t("settings.accounts.delete.title", { name: removing.name })} onClose={() => setRemoving(null)} size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setRemoving(null)}>{t("btn.cancel")}</Button>
              <Button variant="outline" onClick={() => void confirmRemove(false)}>{t("settings.accounts.delete.keepFiles")}</Button>
              <Button variant="danger" onClick={() => void confirmRemove(true)}>{t("settings.accounts.delete.withFiles")}</Button>
            </>
          }>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("settings.accounts.delete.body")}</p>
          <code className="block mt-2 text-[11px] font-mono break-all text-gray-500 dark:text-gray-400">{removing.dir}</code>
        </AppDialog>
      )}
    </>
  );
}
