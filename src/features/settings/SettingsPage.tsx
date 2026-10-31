import { PopupSelect } from "@/shared/ui/PopupSelect";
import { LANGUAGE_OPTIONS, persistLocale } from "@/i18n/locale";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, EditIcon, FolderIcon, ThemeToggle, Tooltip, TrashIcon } from "neogestify-ui-components";
import { AlertaToast } from "@/shared/ui/alerts";
import { useTranslation } from "react-i18next";

import i18n, { setLanguage } from "@/i18n/index";
import { useChatShell, useUiStore, type SettingsSectionId } from "@/app/uiStore";
import { ContasSection } from "@/features/accounts/ContasSection";
import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";
import { useSkillsStore } from "@/features/skills/store";
import { CustomAgentForm } from "@/features/agents/CustomAgentForm";
import { DetectedAgents } from "@/features/agents/DetectedAgents";
import { CliInstallSection } from "@/features/settings/CliInstallSection";
import { GraphifySection } from "@/features/graphify/GraphifySection";
import { SharedMemoryPanel } from "@/features/memory/SharedMemoryPanel";
import { AiMemoryPanel } from "@/features/memory/AiMemoryPanel";
import { SkillsShSection } from "@/features/marketplace/SkillsShSection";
import { OrchestratorSection } from "@/features/orchestrator/OrchestratorSection";
import { RoutingSection } from "@/features/runs/RoutingSection";
import { PrelaunchSection } from "@/features/prelaunch/PrelaunchSection";
import { TerminalSection } from "@/features/terminal/TerminalSection";
import { DecisionsSection } from "@/features/settings/DecisionsSection";
import { ShortcutsSection } from "@/features/settings/ShortcutsSection";
import { SyncSection } from "@/features/sync/SyncSection";
import { UpdatesSection } from "@/features/updates/UpdatesSection";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { DevicesSection } from "@/features/settings/DevicesSection";
import { WorktreesSection } from "@/features/settings/WorktreesSection";
import { ChatModeSetting } from "@/features/chat/ChatModeSetting";
import { SettingsSidebar } from "@/features/chat/ChatPageSidebar";
import { NotificationsSetting } from "@/features/settings/NotificationsSetting";
import { PermissionsSection } from "@/features/chat/permissions/PermissionsSection";
import { AiMemoryTabsSetting } from "@/features/settings/AiMemoryTabsSetting";
import { AgentAutoUpdateSetting } from "@/features/settings/AgentAutoUpdateSetting";
import { SandboxSetting } from "@/features/settings/SandboxSetting";
import { RenderingSetting } from "@/features/settings/RenderingSetting";
import { useTabsStore } from "@/features/tabs/store";

/** Chips de "qué integración tiene configurada esta TUI", para no tener que abrir el
 *  formulario solo para saber si reanuda sesiones o si le gestionamos skills. */
function AgentCapabilities({ agent }: { agent: CustomAgent }) {
  const { t } = useTranslation();
  const caps = [
    agent.resumeArgs && t("settings.tuis.cap.resume"),
    agent.skillsDir && t("settings.tuis.cap.skills"),
    agent.sessionsDir && t("settings.tuis.cap.sessions"),
    Object.keys(agent.env ?? {}).length > 0 && t("settings.tuis.cap.env"),
  ].filter(Boolean) as string[];

  if (caps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {caps.map((c) => (
        <span key={c} className="inline-flex h-4 items-center rounded-full px-1.5
          text-[10px] font-medium
          bg-accent-500/12 text-accent-600 dark:bg-accent-400/15 dark:text-accent-300">
          {c}
        </span>
      ))}
    </div>
  );
}

/** Abas dentro de uma seção que reúne várias coisas (Agentes, Avançado, Geral): um segmentado. */
function SubTabs<T extends string>({ items, value, onChange }: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="self-start inline-flex max-w-full flex-wrap gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.06]">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}
          className={`h-6 px-2.5 rounded-md text-[12px] font-medium ${value === it.id
            ? "bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
            : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

type GeneralTab = "prefs" | "sync" | "updates";
type AgentsTab = "tuis" | "orchestrator" | "routing" | "prelaunch" | "skillsDir" | "skillssh";
type AdvancedTab = "cli" | "graphify";

/**
 * A tela de Configurações (prancheta 5), a mesma nas abas, no canvas e no chat: a barra das seções
 * com a busca e a seção aberta no meio, com título e subtítulo.
 *
 * Contas, que era um modal à parte, é a seção "Contas". As seções que juntam várias coisas
 * (Agentes, Avançado, Geral) as separam em abas, para o meio mostrar UMA coisa por vez em vez de
 * uma rolagem sem fim.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const section = useUiStore((s) => s.settingsSection);
  // No chat a barra das seções é a da casca (`ChatShell`); fora dele a página a desenha.
  const chat = useChatShell();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const activeCwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? s.tabs[0]?.cwd ?? "");
  const customAgents = useAgentsStore((s) => s.customAgents);
  const loadCustomAgents = useAgentsStore((s) => s.loadCustomAgents);
  const saveCustomAgent = useAgentsStore((s) => s.saveCustomAgent);
  const removeCustomAgent = useAgentsStore((s) => s.removeCustomAgent);
  // Excluir uma TUI pede um segundo clique (3 s) e mostra o erro se o backend recusar.
  const [armedAgent, setArmedAgent] = useState<string | null>(null);
  useEffect(() => {
    if (!armedAgent) return;
    const timer = window.setTimeout(() => setArmedAgent(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armedAgent]);
  const deleteCustomAgent = (id: string) => {
    if (armedAgent !== id) { setArmedAgent(id); return; }
    setArmedAgent(null);
    removeCustomAgent(id).catch((e) => AlertaToast(t("btn.delete"), String(e), "error", 6000));
  };
  const skillsDir = useSkillsStore((s) => s.skillsDir);
  const loadSkillsDir = useSkillsStore((s) => s.loadSkillsDir);
  const setSkillsDir = useSkillsStore((s) => s.setSkillsDir);
  /** Id de la TUI que se está editando en línea; `null` = solo el formulario de alta. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [generalTab, setGeneralTab] = useState<GeneralTab>("prefs");
  const [agentsTab, setAgentsTab] = useState<AgentsTab>("tuis");
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>("cli");

  useEffect(() => {
    loadSkillsDir();
    loadCustomAgents().catch(console.error);
  }, [loadSkillsDir, loadCustomAgents]);

  const labels: Record<SettingsSectionId, string> = {
    general: t("settings.general"),
    appearance: t("settings.appearance"),
    chat: t("settings.chat"),
    accounts: t("settings.accounts"),
    agents: t("settings.agents"),
    memory: t("settings.memory"),
    terminal: t("settings.terminal"),
    shortcuts: t("settings.shortcuts"),
    decisions: t("settings.decisions"),
    devices: t("settings.devices"),
    worktrees: t("settings.worktrees"),
    permissions: t("settings.permissions"),
    advanced: t("settings.advanced"),
  };
  const generalTabs = [
    { id: "prefs" as const, label: t("settings.general.prefs") },
    { id: "sync" as const, label: t("settings.sync") },
    { id: "updates" as const, label: t("settings.updates") },
  ];
  const agentsTabs = [
    { id: "tuis" as const, label: t("settings.tuis") },
    { id: "orchestrator" as const, label: t("settings.orchestrator") },
    { id: "routing" as const, label: t("settings.routing") },
    { id: "prelaunch" as const, label: t("settings.prelaunch") },
    { id: "skillsDir" as const, label: t("settings.skillsDir") },
    { id: "skillssh" as const, label: t("settings.skillssh") },
  ];
  const advancedTabs = [
    { id: "cli" as const, label: t("settings.cli") },
    { id: "graphify" as const, label: t("settings.graphify") },
  ];

  const handleChangeSkillsDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("settings.skillsDir") });
    if (typeof selected === "string" && selected) {
      await setSkillsDir(selected);
    }
  };

  const handleLanguage = (lang: string) => {
    void setLanguage(lang);
    persistLocale(localStorage, lang);
  };

  return (
    <div className="@container flex h-full min-h-0 w-full bg-white dark:bg-surface-deep">
      {/* A barra das seções: no chat é a da casca; nas abas e no canvas, a mesma, aqui. */}
      {!chat && <SettingsSidebar />}

      {/* ══ a seção aberta ════════════════════════════════════════════════ */}
      <main className="cc-scroll min-w-0 flex-1 px-6 sm:px-12 pt-4 pb-12">
        <div className={`${section === "decisions" ? "max-w-[1040px]" : "max-w-[736px]"} mx-auto flex flex-col gap-7`}>
          {/* A página tem título e subtítulo (prancheta 5); os cartões vêm abaixo. */}
          <div>
            <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{labels[section]}</h1>
            <p className="mt-1.5 mb-0 text-[14px] text-gray-500 dark:text-white/50">{t(`settings.page.${section}`)}</p>
          </div>
          {section === "general" && (
            <>
              <SubTabs items={generalTabs} value={generalTab} onChange={setGeneralTab} />
              {generalTab === "prefs" && (
                <SettingsSection title={t("settings.general")} description={t("settings.general.desc")}>
                  <SettingsGroup>
                    <SettingsRow label={t("settings.language")}>
                      <PopupSelect value={i18n.language} onChange={(e) => handleLanguage(e.target.value)}>
                        {LANGUAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </PopupSelect>
                    </SettingsRow>
                    <NotificationsSetting />
                    <SandboxSetting />
                  </SettingsGroup>
                </SettingsSection>
              )}
              {generalTab === "sync" && <SyncSection />}
              {generalTab === "updates" && <UpdatesSection />}
            </>
          )}

          {section === "appearance" && (
            <SettingsSection title={t("settings.appearance")} description={t("settings.appearance.desc")}>
              <SettingsGroup>
                <SettingsRow label={t("settings.theme")}>
                  <ThemeToggle />
                </SettingsRow>
                <RenderingSetting />
              </SettingsGroup>
            </SettingsSection>
          )}

          {section === "accounts" && <ContasSection />}

          {section === "agents" && (
            <>
              <SubTabs items={agentsTabs} value={agentsTab} onChange={setAgentsTab} />
              {agentsTab === "tuis" && (
                <SettingsSection title={t("settings.tuis")} description={t("settings.tuis.desc")}>
                  <SettingsGroup>
                    <AgentAutoUpdateSetting />
                    <AiMemoryTabsSetting />
                  </SettingsGroup>
                  <DetectedAgents />

                  <span className="mt-2 text-[11px] leading-[14px] font-semibold uppercase tracking-[0.06em]
                    text-gray-500 dark:text-white/45">
                    {t("settings.tuis.custom")}
                  </span>
                  {customAgents.length === 0 ? (
                    <p className="text-[12px] leading-4 text-gray-500 dark:text-white/40">
                      {t("settings.tuis.empty")}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {customAgents.map((agent) => (
                        editingId === agent.id ? (
                          <CustomAgentForm
                            key={agent.id}
                            initial={agent}
                            onSubmit={async (draft) => {
                              await saveCustomAgent(draft);
                              setEditingId(null);
                            }}
                            onCancel={() => setEditingId(null)}
                          />
                        ) : (
                          <div
                            key={agent.id}
                            className="cc-t flex items-center gap-3 px-3 py-2.5 rounded-xl
                              bg-gray-100/70 dark:bg-surface-raised/60
                              hover:bg-gray-200/60 dark:hover:bg-surface-raised"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0
                              shadow-[0_0_0_3px_rgba(48,209,88,0.18)]" />
                            <div className="flex flex-col gap-px min-w-0 flex-1">
                              <span title={agent.label} className="truncate text-[13px] font-semibold
                                text-gray-900 dark:text-gray-100">
                                {agent.label}
                              </span>
                              <span title={agent.command} className="truncate font-mono text-[11px] tabular-nums
                                text-gray-500 dark:text-white/40">
                                {agent.command}
                              </span>
                              <AgentCapabilities agent={agent} />
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Tooltip content={t("btn.edit")} placement="left">
                                <Button variant="icon"
                                  onClick={() => setEditingId(agent.id)}
                                  aria-label={t("btn.edit")}
                                  className="cc-t flex items-center justify-center w-7 h-7 rounded-md
                                    text-gray-500 dark:text-white/40
                                    hover:text-gray-900 dark:hover:text-white
                                    hover:bg-gray-200 dark:hover:bg-white/10 p-0"
                                >
                                  <EditIcon className="w-3.5 h-3.5" />
                                </Button>
                              </Tooltip>
                              <Tooltip content={t("btn.delete")} placement="left">
                                <Button variant="icon"
                                  onClick={() => deleteCustomAgent(agent.id)}
                                  aria-label={t("btn.delete")}
                                  className="cc-t flex items-center justify-center w-7 h-7 rounded-md
                                    text-gray-500 dark:text-white/40
                                    hover:text-red-500 dark:hover:text-red-400
                                    hover:bg-gray-200 dark:hover:bg-white/10 p-0"
                                >
                                  <TrashIcon className="w-3.5 h-3.5" />
                                </Button>
                              </Tooltip>
                            </div>
                          </div>
                        )
                      ))}
                    </div>
                  )}

                  <CustomAgentForm onSubmit={saveCustomAgent} />
                </SettingsSection>
              )}
              {agentsTab === "orchestrator" && <OrchestratorSection />}
              {agentsTab === "routing" && <RoutingSection />}
              {agentsTab === "prelaunch" && <PrelaunchSection />}
              {agentsTab === "skillsDir" && (
                <SettingsSection
                  title={t("settings.skillsDir")}
                  description={t("settings.skillsDir.desc")}
                  action={
                    <Button variant="outline" size="sm" onClick={handleChangeSkillsDir}>
                      {t("settings.skillsDir.change")}
                    </Button>
                  }
                >
                  <SettingsGroup>
                    <div className="flex items-center gap-2 px-4 py-3.5">
                      <FolderIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />
                      <span title={skillsDir || "…"} className="flex-1 min-w-0 truncate font-mono text-[11.5px] tabular-nums
                        text-gray-700 dark:text-gray-300">
                        {skillsDir || "…"}
                      </span>
                    </div>
                  </SettingsGroup>
                </SettingsSection>
              )}
              {agentsTab === "skillssh" && <SkillsShSection />}
            </>
          )}

          {section === "memory" && (
            <>
              <AiMemoryPanel cwd={activeCwd} workspaceId={workspaceId} />
              {workspaceId
                ? <SharedMemoryPanel key={workspaceId} workspaceId={workspaceId} initialTab="workspace" />
                : <p className="text-[12.5px] text-gray-400 dark:text-white/35">{t("settings.memory.noWorkspace")}</p>}
            </>
          )}

          {section === "chat" && <ChatModeSetting />}
          {section === "devices" && <DevicesSection />}
          {section === "worktrees" && <WorktreesSection />}
          {section === "permissions" && <PermissionsSection />}
          {section === "terminal" && <TerminalSection />}
          {section === "shortcuts" && <ShortcutsSection />}
          {section === "decisions" && <DecisionsSection />}

          {section === "advanced" && (
            <>
              <SubTabs items={advancedTabs} value={advancedTab} onChange={setAdvancedTab} />
              {advancedTab === "cli" && <CliInstallSection />}
              {advancedTab === "graphify" && <GraphifySection />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
