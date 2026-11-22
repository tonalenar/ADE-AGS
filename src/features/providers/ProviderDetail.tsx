import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { reasonText, runAgentUpdate } from "@/features/agents/AgentUpdateWatcher";
import { installRowState, type AgentInstallOffer } from "@/features/agents/installPolicy";
import { agentInstall, agentInstallOffers, agentUpdatesCheck, detectAgents } from "@/features/agents/ipc";
import { hasUpdate, type AgentUpdateInfo } from "@/features/agents/updatePolicy";
import { ChatSwitch, SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { useSettingsTargetStore } from "@/features/settings/settingsTarget";
import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";
import { AlertaToast } from "@/shared/ui/alerts";

import { providerStatus, signInMethods, versionLabel, type SignInMethodId } from "./providersModel";
import { useProvidersStore } from "./store";

export interface ProviderDetailProps {
  agent: AgentInfo;
  onBack: () => void;
  /** Troca para a aba Contas já filtrando este agente. */
  onOpenAccounts?: (agentId: string) => void;
}

/**
 * Detalhe de um agente (Aba Agentes → clicar na linha):
 * mostra Programa, Como entrar e um link "Gerenciar em Contas ›".
 * Não gerencia contas aqui — isso vive exclusivamente na aba Contas.
 */
export function ProviderDetail({ agent, onBack, onOpenAccounts }: ProviderDetailProps) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const capable = useAccountsStore((s) => s.capable);
  const health = useAccountsStore((s) => s.health);
  const load = useAccountsStore((s) => s.load);
  const disabled = useProvidersStore((s) => s.disabled);
  const setEnabled = useProvidersStore((s) => s.setEnabled);
  const setDetectedAgents = useTabsStore((s) => s.setDetectedAgents);
  const goTo = useSettingsTargetStore((s) => s.goTo);

  const [offer, setOffer] = useState<AgentInstallOffer | undefined>();
  const [update, setUpdate] = useState<AgentUpdateInfo | undefined>();
  const [busy, setBusy] = useState<"install" | "update" | null>(null);
  const [method, setMethod] = useState<SignInMethodId>("login");

  const accountCapable = capable.some((c) => c.agentId === agent.id);
  const rows = useMemo(
    () => [...systemAccounts, ...accounts].filter((a) => a.agentId === agent.id),
    [systemAccounts, accounts, agent.id],
  );
  const methods = signInMethods(agent.id, accountCapable);
  const enabled = !disabled.includes(agent.id);
  const Icon = agentIcon(agent.id, agent.label);
  const version = versionLabel(agent.version);
  const status = providerStatus({
    installed: agent.available,
    enabled,
    supportsAccounts: accountCapable,
    accounts: rows,
    health,
  });
  const install = installRowState(agent.available, offer, busy !== null);

  useEffect(() => {
    let stale = false;
    agentInstallOffers()
      .then((list) => { if (!stale) setOffer(list.find((o) => o.agentId === agent.id)); })
      .catch(() => undefined);
    agentUpdatesCheck()
      .then((list) => { if (!stale) setUpdate(list.find((u) => u.agentId === agent.id)); })
      .catch(() => undefined);
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
        AlertaToast(
          agent.label,
          t("settings.tuis.install.failed", {
            label: agent.label,
            error: t(`settings.tuis.install.reason.${result.error ?? "failed"}`, {
              defaultValue: t("settings.tuis.install.reason.failed"),
            }),
          }),
          "error",
          8000,
        );
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
      agentUpdatesCheck()
        .then((list) => setUpdate(list.find((u) => u.agentId === agent.id)))
        .catch(() => undefined);
    }
  };

  const openAccountsTab = () => {
    if (onOpenAccounts) {
      onOpenAccounts(agent.id);
      return;
    }
    goTo({ page: "accounts", tab: "contas", provider: agent.id, anchor: "providers-accounts" });
  };

  const subState = !enabled
    ? t("providers.agent.state.off").toLowerCase()
    : !agent.available
      ? t("providers.agents.notInstalled")
      : status.tone === "warning" || status.tone === "error"
        ? t("providers.agent.state.login").toLowerCase()
        : t("providers.agent.state.ready").toLowerCase();

  const versionText = agent.available
    ? (version
      ? `${version}${update && hasUpdate(update) ? ` · ${t("agents.update.latest", { version: update.latestVersion })}` : ` · ${t("providers.detail.latest")}`}`
      : "—")
    : "—";

  const accountsSummary = accountCapable
    ? (rows.length > 0 ? t("providers.detail.connectedCount", { count: rows.length }) : t("providers.detail.noAccounts"))
    : t("providers.detail.noSeparateAccounts");

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-[12.5px] font-medium text-accent-600 dark:text-accent-400 hover:underline"
      >
        ‹ {t("providers.tab.agents")}
      </button>

      <div className="flex items-center gap-3 mx-0.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-white/80">
          <Icon className="w-5 h-5" />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="m-0 truncate text-[17px] font-semibold text-gray-900 dark:text-white">{agent.label}</h2>
          <p className="m-0 text-[12px] text-gray-400 dark:text-white/40">
            {agent.available && version ? `${version} · ${subState}` : subState}
          </p>
        </div>
        <span className="text-[12.5px] text-gray-500 dark:text-white/50">
          {enabled ? t("providers.detail.enabled") : t("providers.agent.state.off")}
        </span>
        <ChatSwitch
          label={t("providers.toggle", { name: agent.label })}
          checked={enabled}
          onChange={(on) => {
            setEnabled(agent.id, on).catch((e) => AlertaToast(agent.label, String(e), "error", 6000));
          }}
        />
      </div>

      <SettingsSection title={t("providers.detail.program")}>
        <SettingsGroup>
          <SettingsRow
            label={t("providers.detail.where")}
            hint={agent.available ? undefined : t("settings.tuis.notFound", { command: agent.command })}
          >
            <code
              title={agent.path ?? agent.command}
              className="max-w-[340px] truncate rounded bg-gray-100 dark:bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-gray-700 dark:text-gray-200"
            >
              {agent.available ? agent.path ?? agent.command : "—"}
            </code>
          </SettingsRow>
          <SettingsRow label={t("providers.detail.version")}>
            <span className="text-[13px] text-gray-700 dark:text-white/75">{versionText}</span>
          </SettingsRow>
          <SettingsRow label={t("providers.setup.environment")}>
            <span className="text-[13px] text-gray-700 dark:text-white/75">{t("providers.setup.thisComputer")}</span>
          </SettingsRow>
          {(install.kind === "button" || (update && hasUpdate(update))) && (
            <div className="flex items-center justify-end gap-2 px-4 py-3">
              {install.kind === "button" && (
                <Button variant="primary" size="sm" disabled={!install.enabled} onClick={() => void runInstall()}>
                  {busy === "install" ? t("settings.tuis.install.running") : t("providers.setup.install")}
                </Button>
              )}
              {update && hasUpdate(update) && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== null || update.busy || !update.canAutoUpdate}
                  title={update.reason ? reasonText(t, update.reason) : undefined}
                  onClick={() => void runUpdate(update)}
                >
                  {busy === "update"
                    ? t("agents.update.running")
                    : t("providers.agents.updateTo", { version: update.latestVersion })}
                </Button>
              )}
            </div>
          )}
        </SettingsGroup>
        {install.kind === "manual" && (
          <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">
            {t("settings.tuis.install.manual", { command: install.command })}
          </p>
        )}
        {install.kind === "runtime" && (
          <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">{t("settings.tuis.install.runtime")}</p>
        )}
        {install.kind === "app" && (
          <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">
            {t("settings.tuis.install.app", { command: agent.command })}
          </p>
        )}
      </SettingsSection>

      {methods.length > 0 && (
        <SettingsSection title={t("providers.method.title")}>
          <SettingsGroup>
            <div role="radiogroup" aria-label={t("providers.method.title")} className="flex flex-col gap-1.5 p-3">
              {methods.map((m) => {
                const selected = method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!m.available}
                    onClick={() => setMethod(m.id)}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                      ${selected
                        ? "border-accent-500 bg-accent-500/8 dark:bg-accent-500/12"
                        : "border-gray-200 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.03]"}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-accent-500" : "border-gray-300 dark:border-white/25"}`}
                    >
                      {selected && <span className="h-2 w-2 rounded-full bg-accent-500" />}
                    </span>
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[13px] font-medium text-gray-900 dark:text-white">{t(m.labelKey)}</span>
                      {!m.available && m.whyKey && (
                        <span className="text-[12px] text-gray-500 dark:text-white/50">{t(m.whyKey)}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </SettingsGroup>
          {method === "api_key" && (
            <p className="m-0 mx-1 text-[12px] text-gray-500 dark:text-white/45">{t("providers.method.keyNote")}</p>
          )}
        </SettingsSection>
      )}

      <SettingsSection title={t("settings.accounts")}>
        <SettingsGroup>
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="flex-1 text-[13px] text-gray-500 dark:text-white/55">{accountsSummary}</span>
            {accountCapable && (
              <button
                type="button"
                onClick={openAccountsTab}
                className="shrink-0 text-[12.5px] font-medium text-accent-600 dark:text-accent-400 hover:underline"
              >
                {t("providers.detail.manageInAccounts")} ›
              </button>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
