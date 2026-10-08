import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { systemAccounts } from "@/features/accounts/usage";
import { AccountUsagePopover } from "@/features/accounts/AccountUsagePopover";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { accountLoginCommand } from "@/features/accounts/login";
import { AppDialog } from "@/shared/ui/AppDialog";
import type { AgentAccount } from "@/features/accounts/types";
import { useTabsStore } from "@/features/tabs/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { OrchestratorIndicator } from "@/features/orchestrator/OrchestratorIndicator";
import { FleetIndicator } from "@/features/runs/FleetIndicator";
import { BranchIcon } from "@/app/icons";
import type { RepoInfo } from "@/features/explorer/types";
import { Pet, usePetStatus } from "@/shared/brand/Pet";
import { useMascotState } from "@/shared/brand/useMascotState";

/**
 * La franja de abajo: las cuentas de cada TUI, y el estado de la tab activa.
 *
 * Las cuentas van acá y no repetidas en cada tab porque el login es por CUENTA: varias
 * tabs de la misma TUI comparten una sola.
 *
 * Y se lista PRIMERO la principal de cada TUI — la que se usa cuando no hay ningún perfil
 * de por medio. No tiene fila en la base (existía antes que esta app), así que hasta ahora
 * la barra mostraba los perfiles alternativos y escondía justo la que se usa siempre.
 */
export function StatusBar({ repo }: { repo: RepoInfo | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mascot = useMascotState();
  const pet = usePetStatus();
  const profiles = useAccountsStore((s) => s.accounts);
  const load = useAccountsStore((s) => s.load);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const [system, setSystem] = useState<AgentAccount[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<AgentAccount | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    load().catch(console.error);
    systemAccounts().then(setSystem).catch(console.error);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // La principal de cada TUI instalada, más los perfiles con sesión iniciada: un perfil
  // creado y nunca logueado no dice nada acá y solo llenaría la barra.
  const shown = [...system, ...profiles.filter((a) => a.loggedIn)];
  const closeLogin = () => {
    setLoginFor(null);
    load().catch(console.error);
    systemAccounts().then(setSystem).catch(console.error);
  };

  return (
    <footer className="relative flex items-center gap-2.5 h-6 shrink-0 px-3
      bg-gray-100/80 dark:bg-surface-sunken/75 backdrop-blur-xl
      border-t border-gray-200 dark:border-white/[0.08]
      text-[11px] tabular-nums text-gray-500 dark:text-white/50 select-none">

      {/* O mascote é o indicador de humor da janela: repousa, trabalha ou chama você.
          Fica parado em repouso — algo se mexendo o tempo todo no canto do olho cansa. */}
      <Tooltip content={`LV ${pet.level} · ${t(`status.mascot.${mascot.state}`, {
        running: mascot.summary.running,
        count: mascot.summary.needsYou,
      })}`} placement="top" delay={300}>
        <Button variant="custom"
          onClick={() => navigate(mascot.state === "idle" || mascot.state === "sleeping" ? "/" : "/fleet")}
          aria-label={t("sidebar.home")}
          className="cc-t flex items-center gap-1.5 h-5 pl-0.5 pr-1.5 -ml-1 rounded hover:bg-gray-200 dark:hover:bg-white/8"
        >
          {/* Crece con los tokens; trabajando o llamándote se mueve, en reposo queda quieto. */}
          <Pet level={pet.level} state={mascot.state} size={18} still={mascot.state === "idle" || mascot.state === "sleeping"} className="shrink-0 -my-1" />
          <span className="font-mono text-[10px] font-semibold tracking-wider text-gray-600 dark:text-white/70">LV {pet.level}</span>
          <span className="w-8 h-[3px] rounded-full bg-gray-300 dark:bg-white/10 overflow-hidden" aria-hidden>
            <span className="block h-full rounded-full bg-accent-500" style={{ width: `${Math.round(pet.progress * 100)}%` }} />
          </span>
        </Button>
      </Tooltip>

      {shown.map((account) => {
        const Icon = agentIcon(account.agentId, account.agentId);
        return (
          <Button variant="custom"
            key={account.id}
            onClick={() => setOpen((current) => (current === account.id ? null : account.id))}
            title={account.label ?? account.name}
            className={`cc-t flex items-center gap-1.5 h-5 shrink-0 pl-1.5 pr-2.5 rounded-full max-w-52
              ${open === account.id
                ? "bg-gray-300/80 dark:bg-white/12"
                : "bg-gray-200/70 dark:bg-white/5 hover:bg-gray-300/70 dark:hover:bg-white/10"}`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
            <span className="truncate text-[10px] font-medium text-gray-700 dark:text-gray-300">
              {account.label ?? account.name}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0
              ${account.loggedIn ? "bg-emerald-500" : "bg-gray-400 dark:bg-white/25"}`} />
          </Button>
        );
      })}

      {/* El panel se abre HACIA ARRIBA: la barra es lo último de la ventana. */}
      {open && (
        <div
          ref={popRef}
          className="cc-rise absolute bottom-[28px] left-3 z-50
            rounded-lg overflow-hidden
            bg-white/80 dark:bg-surface-raised/80 backdrop-blur-xl
            border border-gray-200 dark:border-white/[0.08]
            shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)]"
        >
          <AccountUsagePopover
            account={shown.find((a) => a.id === open)!}
            onLogin={() => { setLoginFor(shown.find((a) => a.id === open)!); setOpen(null); }}
          />
        </div>
      )}

      <div className="flex-1" />

      {repo?.branch && (
        <>
          <span className="flex items-center gap-1.5 min-w-0 max-w-56">
            <BranchIcon className="w-3 h-3 shrink-0" />
            <span className="truncate font-mono">{repo.branch}</span>
          </span>
          <span className="w-px h-3 bg-gray-300 dark:bg-white/10" />
        </>
      )}

      {activeTab && (
        <>
          <span className="truncate max-w-96 font-mono">{activeTab.cwd}</span>
          <span className="w-px h-3 bg-gray-300 dark:bg-white/10" />
        </>
      )}

      <span className="font-mono">{t("status.agents", { n: tabs.length })}</span>
      <FleetIndicator />
      <OrchestratorIndicator />
      {loginFor && (
        <AppDialog
          title={t("settings.accounts.login.title", { name: loginFor.label ?? loginFor.name })}
          onClose={closeLogin}
          size="lg"
          footer={<Button variant="primary" onClick={closeLogin}>{t("settings.accounts.login.done")}</Button>}
        >
          <p className="text-xs text-gray-500 dark:text-white/50 mb-3">
            {t("settings.accounts.login.helper", { command: accountLoginCommand(loginFor) })}
          </p>
          <LoginTerminal key={loginFor.id} account={loginFor} />
        </AppDialog>
      )}
    </footer>
  );
}
