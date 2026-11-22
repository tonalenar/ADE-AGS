import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { reasonText, runAgentUpdate } from "@/features/agents/AgentUpdateWatcher";
import { installRowState, type AgentInstallOffer } from "@/features/agents/installPolicy";
import { agentInstall, agentInstallOffers, agentSearchPath, agentUpdatesCheck, detectAgents, type SearchPath } from "@/features/agents/ipc";
import { updateButtonState, type AgentUpdateInfo } from "@/features/agents/updatePolicy";
import { AgentAutoUpdateSetting } from "@/features/settings/AgentAutoUpdateSetting";
import { SettingsGroup } from "@/features/settings/SettingsSection";
import { useSettingsTargetStore } from "@/features/settings/settingsTarget";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { AlertaToast } from "@/shared/ui/alerts";
import { uiErrorText } from "@/shared/uiErrorText";

import { ProviderDetail } from "./ProviderDetail";
import { providerStatus, versionLabel, type ProviderTone } from "./providersModel";
import { useProvidersStore } from "./store";

const DOT: Record<ProviderTone, string> = {
  ready: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  disabled: "bg-gray-400 dark:bg-white/30",
  neutral: "bg-emerald-500",
};

function shortStatusKey(tone: ProviderTone, installed: boolean, enabled: boolean): string | null {
  if (!enabled) return "providers.agent.state.off";
  if (!installed) return null;
  if (tone === "warning" || tone === "error") return "providers.agent.state.login";
  return "providers.agent.state.ready";
}

export interface ProvidersSectionProps {
  /** Abre a aba Contas (opcionalmente já selecionando um provedor). */
  onOpenAccounts?: (agentId?: string) => void;
}

/**
 * Aba Agentes (Configurações → Provedores e contas):
 * lista dos agentes detectados com versão, nº de contas, estado e ação rápida de atualizar/instalar;
 * clicar abre o detalhe (Programa, Como entrar e link para Contas). A atualização automática fica aqui.
 */
export function ProvidersSection({ onOpenAccounts }: ProvidersSectionProps = {}) {
  const { t } = useTranslation();
  const detected = useTabsStore((s) => s.detectedAgents);
  const setDetectedAgents = useTabsStore((s) => s.setDetectedAgents);
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const capable = useAccountsStore((s) => s.capable);
  const health = useAccountsStore((s) => s.health);
  const loadAccounts = useAccountsStore((s) => s.load);
  const disabled = useProvidersStore((s) => s.disabled);
  const loadProviders = useProvidersStore((s) => s.load);
  const goTo = useSettingsTargetStore((s) => s.goTo);

  const [openId, setOpenId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [updates, setUpdates] = useState<Record<string, AgentUpdateInfo>>({});
  const [offers, setOffers] = useState<Record<string, AgentInstallOffer>>({});
  const [updating, setUpdating] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [searchPath, setSearchPath] = useState<SearchPath | null>(null);
  const [showPath, setShowPath] = useState(false);

  const refreshUpdates = () =>
    agentUpdatesCheck()
      .then((list) => setUpdates(Object.fromEntries(list.map((u) => [u.agentId, u]))))
      .catch(() => setUpdates({}));

  const refreshOffers = () =>
    agentInstallOffers()
      .then((list) => setOffers(Object.fromEntries(list.map((o) => [o.agentId, o]))))
      .catch(() => setOffers({}));

  useEffect(() => {
    loadAccounts().catch((e) => AlertaToast(t("providers.list"), uiErrorText(e), "error", 6000));
    loadProviders().catch((e) => AlertaToast(t("providers.list"), uiErrorText(e), "error", 6000));
    refreshUpdates();
    refreshOffers();
    agentSearchPath().then(setSearchPath).catch(() => setSearchPath(null));
  }, [loadAccounts, loadProviders, t]);

  const navigateToAccounts = (agentId?: string) => {
    if (onOpenAccounts) {
      onOpenAccounts(agentId);
      return;
    }
    goTo({ page: "accounts", tab: "contas", provider: agentId, anchor: "providers-accounts" });
  };

  const agents = useMemo(() => detected.filter((a) => a.id !== SHELL_AGENT_ID && !a.isCustom), [detected]);
  const open = agents.find((a) => a.id === openId) ?? null;

  if (open) {
    return (
      <ProviderDetail
        agent={open}
        onBack={() => setOpenId(null)}
        onOpenAccounts={(id) => navigateToAccounts(id)}
      />
    );
  }

  const rescan = async () => {
    setScanning(true);
    try {
      setDetectedAgents(await detectAgents(true));
      refreshUpdates();
      refreshOffers();
      await loadAccounts().catch(() => undefined);
    } catch (e) {
      AlertaToast(t("settings.tuis.detected"), String(e), "error", 6000);
    } finally {
      setScanning(false);
    }
  };

  const installError = (code: string | null) =>
    t(`settings.tuis.install.reason.${code ?? "failed"}`, { defaultValue: t("settings.tuis.install.reason.failed") });

  const runInstall = async (agentId: string, label: string) => {
    setInstalling(agentId);
    try {
      const result = await agentInstall(agentId);
      if (result.ok) {
        AlertaToast(label, t("settings.tuis.install.done", { label }), "success", 5000);
        try { setDetectedAgents(await detectAgents(true)); } catch { /* a instalação deu certo */ }
        refreshOffers();
        await loadAccounts().catch(() => undefined);
      } else {
        AlertaToast(label, t("settings.tuis.install.failed", { label, error: installError(result.error) }), "error", 8000);
      }
    } catch (err) {
      AlertaToast(label, t("settings.tuis.install.failed", { label, error: String(err) }), "error", 8000);
    } finally {
      setInstalling(null);
    }
  };

  const runUpdate = async (info: AgentUpdateInfo) => {
    setUpdating(info.agentId);
    try {
      await runAgentUpdate(t, info);
    } catch (err) {
      console.error(err);
    } finally {
      setUpdating(null);
      refreshUpdates();
    }
  };

  const installedCount = agents.filter((a) => a.available).length;
  const shellFailed = searchPath !== null && searchPath.shell !== null && !searchPath.shellOk;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 mx-0.5">
        <span className="flex-1 text-[13px] text-gray-500 dark:text-white/50">
          {t("providers.agents.count", { count: installedCount })}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void rescan()}
          disabled={scanning}
          leftIcon={scanning ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
        >
          {t("settings.tuis.rescan")}
        </Button>
      </div>

      <SettingsGroup>
        {agents.length === 0 && (
          <p className="m-0 px-4 py-5 text-[13px] text-gray-400 dark:text-white/40">{t("providers.empty")}</p>
        )}
        {agents.map((agent) => {
          const Icon = agentIcon(agent.id, agent.label);
          const supportsAccounts = capable.some((c) => c.agentId === agent.id);
          const rows = [...systemAccounts, ...accounts].filter((a) => a.agentId === agent.id);
          const enabled = !disabled.includes(agent.id);
          const status = providerStatus({
            installed: agent.available,
            enabled,
            supportsAccounts,
            accounts: rows,
            health,
          });
          const version = versionLabel(agent.version);
          const statusKey = shortStatusKey(status.tone, agent.available, enabled);
          const info = updates[agent.id];
          const updBtn = info ? updateButtonState(info, updating !== null || installing !== null) : null;
          const updWhy = updBtn?.disabledReason ? reasonText(t, updBtn.disabledReason) : undefined;
          const install = installRowState(agent.available, offers[agent.id], installing !== null || updating !== null);

          const accountPart = supportsAccounts
            ? (rows.length > 0 ? t("providers.agents.accountsCount", { count: rows.length }) : t("providers.agents.noAccounts"))
            : null;
          const sub = agent.available
            ? [version, accountPart].filter(Boolean).join(" · ") || agent.command
            : t("providers.agents.notInstalled");

          return (
            <div key={agent.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50/70 dark:hover:bg-white/[0.025] transition-colors">
              <button
                type="button"
                onClick={() => setOpenId(agent.id)}
                aria-label={t("providers.open", { name: agent.label })}
                className="flex flex-1 min-w-0 items-center gap-3 text-left rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-white/80">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <b className="truncate text-[13.5px] font-semibold text-gray-900 dark:text-white">{agent.label}</b>
                  <span className="truncate text-[12px] text-gray-400 dark:text-white/40">{sub}</span>
                </span>
              </button>

              {info && updBtn?.visible && (
                <span title={updWhy} className="shrink-0">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!updBtn.enabled}
                    onClick={(e) => { e.stopPropagation(); void runUpdate(info); }}
                    leftIcon={updating === agent.id ? <AnimateSpin className="w-3 h-3" /> : undefined}
                  >
                    {updating === agent.id
                      ? t("agents.update.running")
                      : t("providers.agents.updateTo", { version: info.latestVersion })}
                  </Button>
                </span>
              )}

              {install.kind === "button" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!install.enabled}
                  onClick={(e) => { e.stopPropagation(); void runInstall(agent.id, agent.label); }}
                  leftIcon={installing === agent.id ? <AnimateSpin className="w-3 h-3" /> : undefined}
                >
                  {installing === agent.id ? t("settings.tuis.install.running") : t("providers.setup.install")}
                </Button>
              )}

              {statusKey && (
                <span className="inline-flex items-center gap-1.5 shrink-0 text-[12px] text-gray-500 dark:text-white/55 whitespace-nowrap">
                  <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[status.tone]}`} />
                  {t(statusKey)}
                </span>
              )}

              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => setOpenId(agent.id)}
                className="shrink-0 text-[16px] leading-none text-gray-400 dark:text-white/30"
              >
                ›
              </button>
            </div>
          );
        })}
      </SettingsGroup>

      <SettingsGroup>
        <AgentAutoUpdateSetting />
      </SettingsGroup>

      <p className="m-0 mx-0.5 text-[12px] text-gray-400 dark:text-white/40">
        {t("providers.agents.footerBefore")}{" "}
        <button
          type="button"
          onClick={() => navigateToAccounts()}
          className="font-medium text-accent-600 dark:text-accent-400 hover:underline"
        >
          {t("settings.accounts")}
        </button>
        {t("providers.agents.footerAfter")}
      </p>

      {searchPath && (
        <div className="flex flex-col gap-1.5 mx-0.5">
          <button
            type="button"
            onClick={() => setShowPath((v) => !v)}
            className="self-start text-[11.5px] text-gray-400 dark:text-white/40 hover:text-gray-700 dark:hover:text-white/70 hover:underline"
          >
            {showPath ? t("settings.tuis.path.hide") : t("settings.tuis.path.show")}
          </button>

          {(showPath || shellFailed) && (
            <p className="m-0 text-[11px] leading-relaxed text-gray-500 dark:text-white/45">
              {searchPath.shell === null
                ? t("settings.tuis.path.windows")
                : searchPath.shellOk
                  ? t("settings.tuis.path.shellOk", { shell: searchPath.shell, count: searchPath.fromShell.length })
                  : t("settings.tuis.path.shellFailed", { shell: searchPath.shell, error: searchPath.shellError ?? "" })}
              {` ${t("settings.tuis.path.hint")}`}
            </p>
          )}

          {showPath && (
            <div className="flex flex-col gap-px max-h-48 overflow-auto cc-scroll px-3 py-2 rounded-lg bg-gray-100/70 dark:bg-white/4">
              {searchPath.effective.map((dir) => (
                <span key={dir} className="flex items-center gap-2 font-mono text-[11px] text-gray-600 dark:text-gray-300">
                  <span className="truncate" title={dir}>{dir}</span>
                  {searchPath.fromShell.includes(dir) && (
                    <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">{t("settings.tuis.path.fromShell")}</span>
                  )}
                  {searchPath.known.includes(dir) && (
                    <span className="shrink-0 text-[10px] text-gray-400 dark:text-white/30">{t("settings.tuis.path.known")}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
