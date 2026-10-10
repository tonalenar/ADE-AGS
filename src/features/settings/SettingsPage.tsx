import { PopupSelect } from "@/shared/ui/PopupSelect";
import { LANGUAGE_OPTIONS, persistLocale } from "@/i18n/locale";
import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertaToast, Button, EditIcon, FolderIcon, ThemeToggle, Tooltip, TrashIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n/index";
import { useUiStore, type SettingsSectionId } from "@/app/uiStore";
import { ContasSection } from "@/features/accounts/ContasSection";
import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";
import { useSkillsStore } from "@/features/skills/store";
import { CustomAgentForm } from "@/features/agents/CustomAgentForm";
import { DetectedAgents } from "@/features/agents/DetectedAgents";
import { CliInstallSection } from "@/features/settings/CliInstallSection";
import { GraphifySection } from "@/features/graphify/GraphifySection";
import { MemoryRail } from "@/features/settings/MemoryRail";
import { SharedMemoryPanel } from "@/features/memory/SharedMemoryPanel";
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
import { NotificationsSetting } from "@/features/settings/NotificationsSetting";
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

/** Cada item da barra lateral tem o seu quadradinho de cor com um glifo, como os Ajustes do macOS. */
const GLYPH: Record<SettingsSectionId, { tone: string; icon: React.ReactNode }> = {
  general: { tone: "bg-gray-500", icon: <><circle cx="8" cy="8" r="2.2" /><circle cx="8" cy="8" r="5.6" strokeDasharray="2.4 1.8" /></> },
  appearance: { tone: "bg-accent-500", icon: <><circle cx="8" cy="8" r="5.6" /><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" /></> },
  accounts: { tone: "bg-green-500", icon: <><circle cx="8" cy="5.6" r="2.4" /><path d="M3 13.2c.7-2.2 2.5-3.4 5-3.4s4.3 1.2 5 3.4" /></> },
  agents: { tone: "bg-orange-500", icon: <><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" /><path d="M6.4 1.8v2.4M9.6 1.8v2.4M6.4 11.8v2.4M9.6 11.8v2.4M1.8 6.4h2.4M1.8 9.6h2.4M11.8 6.4h2.4M11.8 9.6h2.4" /></> },
  memory: { tone: "bg-purple-500", icon: <><path d="M8 2.2 13.6 5 8 7.8 2.4 5 8 2.2Z" /><path d="m2.4 8 5.6 2.8L13.6 8M2.4 11l5.6 2.8L13.6 11" /></> },
  terminal: { tone: "bg-sky-400", icon: <><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.2" /><path d="M4.6 6.4 6.6 8l-2 1.6M8.8 10.2h2.6" /></> },
  shortcuts: { tone: "bg-red-500", icon: <><rect x="1.4" y="4" width="13.2" height="8" rx="2" /><path d="M4 6.8h.01M6.8 6.8h.01M9.6 6.8h.01M12 6.8h.01M4.4 9.4h7.2" /></> },
  decisions: { tone: "bg-teal-600", icon: <><circle cx="8" cy="3.2" r="1.5" /><circle cx="4.2" cy="12.2" r="1.5" /><circle cx="11.8" cy="12.2" r="1.5" /><path d="M8 4.7v2.4M8 7.1 4.2 10.7M8 7.1l3.8 3.6" /></> },
  advanced: { tone: "bg-gray-600", icon: <><path d="M2 4.6h12M2 11.4h12" /><circle cx="5.6" cy="4.6" r="1.5" /><circle cx="10.4" cy="11.4" r="1.5" /></> },
};

/** Os dois grupos da barra lateral (a linha entre eles é a da prancheta). */
const NAV: SettingsSectionId[][] = [
  ["general", "appearance", "accounts", "agents"],
  ["memory", "terminal", "shortcuts", "decisions", "advanced"],
];

function Glyph({ id }: { id: SettingsSectionId }) {
  const glyph = GLYPH[id];
  return (
    <span className={`flex size-[22px] shrink-0 items-center justify-center rounded-md text-white ${glyph.tone}`}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {glyph.icon}
      </svg>
    </span>
  );
}

/** Abas dentro de uma seção que reúne várias coisas (Agentes, Avançado, Geral): um segmentado. */
function SubTabs<T extends string>({ items, value, onChange }: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="mb-4 inline-flex max-w-full flex-wrap gap-0.5 rounded-[9px] bg-black/[0.05] p-0.5 dark:bg-surface-raised">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}
          className={`h-[26px] rounded-[7px] px-3 text-[12.5px] font-medium transition-colors ${value === it.id
            ? "bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-surface-overlay dark:text-white dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
            : "text-gray-500 hover:text-gray-900 dark:text-white/55 dark:hover:text-white"}`}>
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
 * A tela de Configurações, TUDO numa tela só (prancheta 5): a barra lateral com a busca, a seção
 * aberta no meio e o painel de memória à direita.
 *
 * Contas, que era um modal à parte, é a seção "Contas". As seções que juntam várias coisas
 * (Agentes, Avançado, Geral) as separam em abas, para o meio mostrar UMA coisa por vez em vez de
 * uma rolagem sem fim.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);
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
    accounts: t("settings.accounts"),
    agents: t("settings.agents"),
    memory: t("settings.memory"),
    terminal: t("settings.terminal"),
    shortcuts: t("settings.shortcuts"),
    decisions: t("settings.decisions"),
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

  // Busca da barra lateral: acha a seção pelo nome dela ou pelo de qualquer aba que ela tenha.
  const [filter, setFilter] = useState("");
  const terms = useMemo<Record<SettingsSectionId, string>>(() => ({
    general: [labels.general, ...generalTabs.map((x) => x.label), t("settings.language")].join(" "),
    appearance: [labels.appearance, t("settings.theme")].join(" "),
    accounts: [labels.accounts].join(" "),
    agents: [labels.agents, ...agentsTabs.map((x) => x.label)].join(" "),
    memory: labels.memory,
    terminal: labels.terminal,
    shortcuts: labels.shortcuts,
    decisions: [labels.decisions, t("settings.decisions.provider"), "laya", "jev"].join(" "),
    advanced: [labels.advanced, ...advancedTabs.map((x) => x.label)].join(" "),
  }), [t]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = filter.trim().toLocaleLowerCase();
  const matches = (id: SettingsSectionId) => !q || terms[id].toLocaleLowerCase().includes(q);
  const firstMatch = NAV.flat().find(matches);

  const handleChangeSkillsDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("settings.skillsDir") });
    if (typeof selected === "string" && selected) {
      await setSkillsDir(selected);
    }
  };

  const handleLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    persistLocale(localStorage, lang);
  };

  const workspaceName = activeCwd.split(/[\\/]/).filter(Boolean).pop() ?? t("settings.workspace");

  return (
    <div className="@container flex h-full min-h-0 w-full bg-gray-50 dark:bg-surface-deep">
      {/* ══ a barra lateral ═══════════════════════════════════════════════ */}
      <nav aria-label={t("settings.title")} className="flex w-[208px] shrink-0 flex-col min-h-0
        border-r border-black/[0.08] dark:border-[rgba(84,84,88,0.55)] bg-gray-100/60 dark:bg-surface">
        <label className="mx-3 mt-3 mb-2 flex h-8 shrink-0 items-center gap-2 rounded-[9px] pl-2.5 pr-2
          bg-black/[0.05] dark:bg-surface-raised text-gray-400 dark:text-white/30
          focus-within:ring-[3px] focus-within:ring-accent-500/25">
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" className="h-3.5 w-3.5 shrink-0" aria-hidden><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2 16 16" /></svg>
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && firstMatch) setSection(firstMatch); if (e.key === "Escape" && filter) { e.stopPropagation(); setFilter(""); } }}
            placeholder={t("settings.search")} aria-label={t("settings.search")}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/30 outline-none" />
        </label>
        <div className="cc-scroll flex min-h-0 flex-1 flex-col gap-0.5 px-2 pb-3">
          {!firstMatch && <p className="px-2 py-3 text-[12px] text-gray-400 dark:text-white/35">{t("settings.searchEmpty")}</p>}
          {NAV.map((group, gi) => {
            const visible = group.filter(matches);
            if (visible.length === 0) return null;
            return (
              <div key={gi} className={`flex flex-col gap-0.5 ${gi > 0 && NAV.slice(0, gi).some((g) => g.some(matches)) ? "mt-1 border-t border-black/[0.08] pt-2 dark:border-[rgba(84,84,88,0.55)]" : ""}`}>
                {visible.map((id) => (
                  <Button variant="custom" key={id} onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined}
                    className={`cc-t flex h-8 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] leading-[18px]
                      ${section === id
                        ? "bg-accent-500 text-white font-medium"
                        : "text-gray-800 dark:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-white/[0.06]"}`}>
                    <Glyph id={id} />
                    <span className="truncate">{labels[id]}</span>
                  </Button>
                ))}
              </div>
            );
          })}
        </div>
      </nav>

      {/* ══ a seção aberta ════════════════════════════════════════════════ */}
      <main className="cc-scroll min-w-0 flex-1 px-8 py-6">
        <div className="max-w-[760px]">
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
                              <span className="truncate text-[13px] font-semibold
                                text-gray-900 dark:text-gray-100">
                                {agent.label}
                              </span>
                              <span className="truncate font-mono text-[11px] tabular-nums
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
                    <div className="flex items-center gap-2 min-h-10 px-3 py-2">
                      <FolderIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />
                      <span className="flex-1 min-w-0 truncate font-mono text-[11.5px] tabular-nums
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
            workspaceId
              ? <SharedMemoryPanel key={workspaceId} workspaceId={workspaceId} initialTab="workspace" />
              : <p className="text-[12.5px] text-gray-400 dark:text-white/35">{t("settings.memory.noWorkspace")}</p>
          )}

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

      {/* ══ o painel de memória ═══════════════════════════════════════════ */}
      {workspaceId && (
        <MemoryRail workspaceId={workspaceId} workspaceName={workspaceName}
          onOpenMemory={section === "memory" ? undefined : () => setSection("memory")} />
      )}
    </div>
  );
}
