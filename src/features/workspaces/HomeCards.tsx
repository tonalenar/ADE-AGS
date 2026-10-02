import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, SearchIcon, WarningIcon } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { PALETTE_SHORTCUT } from "@/app/shortcuts";
import { useAccountsStore } from "@/features/accounts/store";
import { formatTokens, systemAccounts } from "@/features/accounts/usage";
import type { AgentAccount } from "@/features/accounts/types";
import { agentIcon } from "@/features/agents/agentIcons";
import { useRunsStore } from "@/features/runs/store";
import { useTabsStore } from "@/features/tabs/store";
import { Pet, usePetStatus } from "@/shared/brand/Pet";
import { useMascotState } from "@/shared/brand/useMascotState";

/** O nome da pasta, que é como as pessoas reconhecem um projeto. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Moldura comum dos cards da coluna lateral. */
function Card({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 dark:border-white/8 bg-white dark:bg-surface-raised">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          {title}
        </h3>
        {count != null && count > 0 && (
          <span className="text-[11px] tabular-nums text-gray-400 dark:text-gray-500">{count}</span>
        )}
      </header>
      <div className="pb-2">{children}</div>
    </section>
  );
}

function Row({ icon, title, meta, onClick, tone }: {
  icon: React.ReactNode;
  title: string;
  meta?: string;
  onClick: () => void;
  tone?: "warning";
}) {
  return (
    <Button variant="custom"
      onClick={onClick}
      className="cc-t w-full flex items-center gap-2.5 px-4 py-1.5 text-left
        hover:bg-gray-50 dark:hover:bg-white/5"
    >
      <span className={`shrink-0 flex ${tone === "warning" ? "text-amber-500" : "text-gray-400 dark:text-gray-500"}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-gray-800 dark:text-gray-200">{title}</span>
        {meta && <span className="block truncate text-[11px] font-mono text-gray-400 dark:text-gray-500">{meta}</span>}
      </span>
    </Button>
  );
}

/**
 * O topo da Home: o mascote, o nome e uma linha que diz como está tudo agora. Também é
 * onde a paleta se apresenta — quem não conhece o Ctrl+K o descobre aqui.
 */
export function HomeHeader() {
  const { t } = useTranslation();
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const { state, summary } = useMascotState();
  const pet = usePetStatus();

  return (
    <div className="flex items-center gap-5">
      {/* El pet de verdad (el que evoluciona), no el mascote fijo: aquí se ve crecer. */}
      <Pet level={pet.level} state={state} size={88} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="text-gray-900 dark:text-gray-50">ADE</span>{" "}
          <span className="text-gray-400 dark:text-gray-500">AGS</span>
          <span className="ml-3 align-middle text-[12px] font-bold tracking-wider text-gray-500 dark:text-gray-400"
            title={`${formatTokens(pet.xp)} tokens`}>
            LV {pet.level}
          </span>
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(`home.status.${state}`, { running: summary.running, count: summary.needsYou })}
        </p>
        <div className="mt-1.5 flex items-center gap-2 max-w-64">
          <div className="flex-1 h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden"
            role="progressbar" aria-valuenow={Math.round(pet.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent-500 transition-[width] duration-700" style={{ width: `${Math.round(pet.progress * 100)}%` }} />
          </div>
          <span className="text-[10.5px] tabular-nums text-gray-400 dark:text-gray-500">
            {pet.toNext > 0 ? `-${formatTokens(pet.toNext)} → ${pet.level + 1}` : "MAX"}
          </span>
        </div>
      </div>
      <Button variant="custom"
        onClick={() => setPaletteOpen(true)}
        className="cc-t hidden sm:flex items-center gap-2 h-9 pl-3 pr-2 rounded-lg shrink-0
          border border-gray-200 dark:border-white/10
          text-[12.5px] text-gray-500 dark:text-gray-400
          hover:border-gray-300 dark:hover:border-white/20 hover:text-gray-800 dark:hover:text-gray-200"
      >
        <SearchIcon className="w-3.5 h-3.5" />
        {t("palette.open")}
        <kbd className="ml-3 text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/8">
          {PALETTE_SHORTCUT}
        </kbd>
      </Button>
    </div>
  );
}

/** Permissões que algum agente da frota está esperando. Some quando não há nenhuma. */
export function AttentionCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const approvals = useRunsStore((s) => s.approvals);
  const tasks = useRunsStore((s) => s.tasks);
  const titles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  if (approvals.length === 0) return null;

  return (
    <Card title={t("home.card.attention")} count={approvals.length}>
      {approvals.slice(0, 5).map((a) => (
        <Row
          key={a.id}
          tone="warning"
          icon={<WarningIcon className="w-4 h-4" />}
          title={titles.get(a.taskId) ?? a.toolName}
          meta={a.toolName}
          onClick={() => navigate("/fleet")}
        />
      ))}
    </Card>
  );
}

/** Os agentes abertos nesta janela, para pular direto a um. */
export function OpenAgentsCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tabs = useTabsStore((s) => s.tabs);
  const activateTab = useTabsStore((s) => s.activateTab);

  return (
    <Card title={t("home.card.agents")} count={tabs.length}>
      {tabs.length === 0 ? (
        <p className="px-4 pb-2 text-[12.5px] text-gray-400 dark:text-gray-500">{t("home.card.agentsEmpty")}</p>
      ) : (
        tabs.map((tab) => {
          const Icon = agentIcon(tab.agentId, tab.agentId);
          return (
            <Row
              key={tab.id}
              icon={<Icon className="w-4 h-4" />}
              title={tab.title}
              meta={folderName(tab.cwd)}
              onClick={() => { activateTab(tab.id); navigate("/workspace"); }}
            />
          );
        })
      )}
    </Card>
  );
}

/**
 * As contas de cada TUI e se têm sessão iniciada. O consumo fica na barra de status e na
 * tela de Contas: perguntar o cupo levanta a TUI inteira, e a Home não pode custar isso
 * cada vez que se abre.
 */
export function AccountsCard() {
  const { t } = useTranslation();
  const setAccountsOpen = useUiStore((s) => s.setAccountsOpen);
  const profiles = useAccountsStore((s) => s.accounts);
  const [system, setSystem] = useState<AgentAccount[]>([]);

  useEffect(() => {
    systemAccounts().then(setSystem).catch(console.error);
  }, []);

  const shown = [...system, ...profiles.filter((a) => a.loggedIn)];

  return (
    <Card title={t("home.card.accounts")}>
      {shown.length === 0 ? (
        <p className="px-4 pb-2 text-[12.5px] text-gray-400 dark:text-gray-500">{t("home.card.accountsEmpty")}</p>
      ) : (
        shown.map((account) => {
          const Icon = agentIcon(account.agentId, account.agentId);
          return (
            <Row
              key={account.id}
              icon={
                <span className="relative flex">
                  <Icon className="w-4 h-4" />
                  <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-2 ring-white dark:ring-surface-raised
                    ${account.loggedIn ? "bg-emerald-500" : "bg-gray-400 dark:bg-white/25"}`} />
                </span>
              }
              title={account.label ?? account.name}
              meta={account.loggedIn ? t("home.card.loggedIn") : t("home.card.loggedOut")}
              onClick={() => setAccountsOpen(true)}
            />
          );
        })
      )}
    </Card>
  );
}
