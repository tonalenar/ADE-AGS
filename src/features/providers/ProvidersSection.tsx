import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { useAccountsStore } from "@/features/accounts/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { ChatSwitch, SettingsGroup } from "@/features/settings/SettingsSection";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";
import { AlertaToast } from "@/shared/ui/alerts";

import { ProviderDetail } from "./ProviderDetail";
import { providerStatus, versionLabel, type ProviderTone } from "./providersModel";
import { useProvidersStore } from "./store";

const DOT: Record<ProviderTone, string> = {
  ready: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  disabled: "bg-gray-300 dark:bg-white/25",
  neutral: "bg-gray-400 dark:bg-white/40",
};

/** O último trecho do caminho, para dizer "para <projeto>" sem mostrar a pasta inteira. */
function projectName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/**
 * Configurações → Provedores, no desenho do T3 Code: a lista dos agentes com versão, estado do login e
 * uma chave liga/desliga; "Adicionar provedor" (outra conta) e, ao abrir um, o detalhe com Estado,
 * Instalação, Conta e Forma de entrada. As contas são as da ADE (`accounts`): uma pasta de login por
 * conta, a mesma ideia das instâncias do T3.
 */
export function ProvidersSection() {
  const { t } = useTranslation();
  const detected = useTabsStore((s) => s.detectedAgents);
  const cwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? s.tabs[0]?.cwd ?? "");
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const capable = useAccountsStore((s) => s.capable);
  const health = useAccountsStore((s) => s.health);
  const loadAccounts = useAccountsStore((s) => s.load);
  const disabled = useProvidersStore((s) => s.disabled);
  const loadProviders = useProvidersStore((s) => s.load);
  const setEnabled = useProvidersStore((s) => s.setEnabled);
  const [openId, setOpenId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    loadAccounts().catch(() => undefined);
    loadProviders().catch(() => undefined);
  }, [loadAccounts, loadProviders]);

  const agents = useMemo(() => detected.filter((a) => a.id !== SHELL_AGENT_ID && !a.isCustom), [detected]);
  const open = agents.find((a) => a.id === openId) ?? null;

  if (open) {
    return <ProviderDetail agent={open} onBack={() => setOpenId(null)} />;
  }

  const project = projectName(cwd);
  const toggle = (agent: AgentInfo, on: boolean) => {
    setEnabled(agent.id, on).catch((e) => AlertaToast(agent.label, String(e), "error", 6000));
  };

  return (
    <>
      <p className="m-0 mx-1 text-[13px] text-gray-500 dark:text-white/50">
        {project ? t("providers.scope", { project }) : t("providers.scope.none")}
      </p>

      <section aria-label={t("providers.list")} className="flex flex-col gap-2">
        <div className="flex items-center gap-2 mx-1">
          <h2 className="m-0 flex-1 text-[13px] font-medium text-gray-500 dark:text-white/50">{t("providers.list")}</h2>
          <Button variant="outline" size="sm" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            + {t("providers.add")}
          </Button>
        </div>

        {menu && (
          <div role="menu" className="flex flex-col rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-1">
            <p className="m-0 px-3 py-1.5 text-[12px] text-gray-500 dark:text-white/50">{t("providers.add.hint")}</p>
            {capable.length === 0 && <p className="m-0 px-3 py-1.5 text-[12.5px] text-gray-400 dark:text-white/40">{t("providers.add.none")}</p>}
            {capable.map((c) => {
              const Icon = agentIcon(c.agentId, c.label);
              return (
                <button key={c.agentId} type="button" role="menuitem"
                  onClick={() => { setMenu(false); setAdding(c.agentId); }}
                  className="flex items-center gap-2 h-8 px-3 rounded-lg text-left text-[13px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
                  <Icon className="w-4 h-4 shrink-0" />{c.label}
                </button>
              );
            })}
          </div>
        )}

        <SettingsGroup>
          {agents.length === 0 && <p className="m-0 px-4 py-5 text-[13px] text-gray-400 dark:text-white/40">{t("providers.empty")}</p>}
          {agents.map((agent) => {
            const Icon = agentIcon(agent.id, agent.label);
            const rows = [...systemAccounts, ...accounts].filter((a) => a.agentId === agent.id);
            const enabled = !disabled.includes(agent.id);
            const status = providerStatus({
              installed: agent.available,
              enabled,
              supportsAccounts: capable.some((c) => c.agentId === agent.id),
              accounts: rows,
              health,
            });
            const version = versionLabel(agent.version);
            return (
              <div key={agent.id} className="flex items-center gap-3 px-4 py-3">
                <button type="button" onClick={() => setOpenId(agent.id)} aria-label={t("providers.open", { name: agent.label })}
                  className="flex flex-1 min-w-0 items-center gap-3 text-left rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40">
                  <Icon className="w-5 h-5 shrink-0 text-gray-700 dark:text-white/70" />
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="flex items-center gap-2 min-w-0">
                      <b className="truncate text-[14px] font-medium text-gray-900 dark:text-white">{agent.label}</b>
                      {version && <span className="shrink-0 text-[12px] text-gray-400 dark:text-white/40">{version}</span>}
                    </span>
                    <span className="flex items-center gap-1.5 min-w-0 text-[12.5px] text-gray-500 dark:text-white/50">
                      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status.tone]}`} />
                      <span className="truncate">{t(status.key, status.vars)}</span>
                    </span>
                  </span>
                </button>
                <ChatSwitch label={t("providers.toggle", { name: agent.label })} checked={enabled} onChange={(on) => toggle(agent, on)} />
              </div>
            );
          })}
        </SettingsGroup>
        {disabled.length > 0 && <p className="m-0 mx-1 text-[12px] text-gray-400 dark:text-white/40">{t("providers.disabledNote")}</p>}
      </section>

      {adding && <AddAccountDialog agentId={adding} onClose={() => setAdding(null)} />}
    </>
  );
}
