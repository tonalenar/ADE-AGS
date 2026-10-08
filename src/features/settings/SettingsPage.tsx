import { LANGUAGE_OPTIONS, persistLocale } from "@/i18n/locale";
import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button, EditIcon, FolderIcon, Select, ThemeToggle, Tooltip, TrashIcon,
} from "neogestify-ui-components";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n/index";
import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";
import { useSkillsStore } from "@/features/skills/store";
import { CustomAgentForm } from "@/features/agents/CustomAgentForm";
import { DetectedAgents } from "@/features/agents/DetectedAgents";
import { CliInstallSection } from "@/features/settings/CliInstallSection";
import { GraphifySection } from "@/features/graphify/GraphifySection";
import { SkillsShSection } from "@/features/marketplace/SkillsShSection";
import { OrchestratorSection } from "@/features/orchestrator/OrchestratorSection";
import { RoutingSection } from "@/features/runs/RoutingSection";
import { PrelaunchSection } from "@/features/prelaunch/PrelaunchSection";
import { TerminalSection } from "@/features/terminal/TerminalSection";
import { ShortcutsSection } from "@/features/settings/ShortcutsSection";
import { SyncSection } from "@/features/sync/SyncSection";
import { UpdatesSection } from "@/features/updates/UpdatesSection";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { NotificationsSetting } from "@/features/settings/NotificationsSetting";
import { AgentAutoUpdateSetting } from "@/features/settings/AgentAutoUpdateSetting";
import { SandboxSetting } from "@/features/settings/SandboxSetting";
import { RenderingSetting } from "@/features/settings/RenderingSetting";

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

type SectionId =
  | "appearance" | "shortcuts" | "terminal" | "skillsDir" | "skillssh"
  | "tuis" | "prelaunch" | "cli" | "graphify" | "orchestrator" | "routing" | "sync" | "updates";

/** Cada sección del riel tiene su cuadradito de color con un glifo, como Ajustes del macOS. */
const SECTION_GLYPH: Record<SectionId, { tone: string; icon: React.ReactNode }> = {
  appearance: { tone: "bg-accent-500", icon: <><circle cx="8" cy="8" r="5.6" /><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" /></> },
  shortcuts: { tone: "bg-red-500", icon: <><rect x="1.4" y="4" width="13.2" height="8" rx="2" /><path d="M4 6.8h.01M6.8 6.8h.01M9.6 6.8h.01M12 6.8h.01M4.4 9.4h7.2" /></> },
  terminal: { tone: "bg-teal-500", icon: <><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.2" /><path d="M4.6 6.4 6.6 8l-2 1.6M8.8 10.2h2.6" /></> },
  skillsDir: { tone: "bg-orange-500", icon: <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /> },
  skillssh: { tone: "bg-violet-500", icon: <path d="M8 2.2 9.4 6.6 13.8 8 9.4 9.4 8 13.8 6.6 9.4 2.2 8 6.6 6.6z" /> },
  tuis: { tone: "bg-emerald-500", icon: <><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" /><path d="M6.4 1.8v2.4M9.6 1.8v2.4M6.4 11.8v2.4M9.6 11.8v2.4M1.8 6.4h2.4M1.8 9.6h2.4M11.8 6.4h2.4M11.8 9.6h2.4" /></> },
  prelaunch: { tone: "bg-amber-500", icon: <path d="M5 3.5v9l7-4.5z" /> },
  cli: { tone: "bg-gray-500", icon: <><path d="M8 2 13.5 5v6L8 14 2.5 11V5z" /><path d="M2.5 5 8 8l5.5-3M8 8v6" /></> },
  graphify: { tone: "bg-sky-500", icon: <><circle cx="4" cy="4.2" r="1.6" /><circle cx="12" cy="4.2" r="1.6" /><circle cx="8" cy="12" r="1.6" /><path d="M5.3 5 7 10.6M10.7 5 9 10.6M5.6 4.2h4.8" /></> },
  orchestrator: { tone: "bg-indigo-500", icon: <><path d="M2 4.6h12M2 11.4h12" /><circle cx="5.6" cy="4.6" r="1.5" /><circle cx="10.4" cy="11.4" r="1.5" /></> },
  routing: { tone: "bg-pink-500", icon: <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" /><path d="M4.5 5v6M11.5 6.5c0 2.5-3 2.5-7 4.5" /></> },
  sync: { tone: "bg-cyan-500", icon: <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.8v3h-3" /> },
  updates: { tone: "bg-blue-500", icon: <><circle cx="8" cy="8" r="5.8" /><path d="M8 4.8v5M5.9 7.9 8 10l2.1-2.1" /></> },
};

function SectionIcon({ id }: { id: SectionId }) {
  const glyph = SECTION_GLYPH[id];
  return (
    <span className={`flex size-[22px] shrink-0 items-center justify-center rounded-md text-white ${glyph.tone}`}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {glyph.icon}
      </svg>
    </span>
  );
}

/**
 * El contenido de Configuración.
 *
 * Muestra UNA sección por vez en vez de apilarlas todas en un scroll con índice al
 * costado. En una ventana de alto fijo, el scroll largo obligaba a recorrer ajustes que no
 * se estaban buscando para llegar al que sí — y el índice existía justamente para
 * compensar eso. Eligiendo, la navegación deja de ser un parche sobre el scroll.
 *
 * Las cuentas ya no están acá: son algo que se administra y crece, no un ajuste, así que
 * tienen su propia pantalla (`AccountsModal`) y su propio botón en el riel.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const customAgents = useAgentsStore((s) => s.customAgents);
  const loadCustomAgents = useAgentsStore((s) => s.loadCustomAgents);
  const saveCustomAgent = useAgentsStore((s) => s.saveCustomAgent);
  const removeCustomAgent = useAgentsStore((s) => s.removeCustomAgent);
  const skillsDir = useSkillsStore((s) => s.skillsDir);
  const loadSkillsDir = useSkillsStore((s) => s.loadSkillsDir);
  const setSkillsDir = useSkillsStore((s) => s.setSkillsDir);
  /** Id de la TUI que se está editando en línea; `null` = solo el formulario de alta. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>("appearance");

  useEffect(() => {
    loadSkillsDir();
    loadCustomAgents().catch(console.error);
  }, [loadSkillsDir, loadCustomAgents]);

  // El orden de la navegación. Agregar una sección es una línea acá más su caso abajo.
  const sections: { id: SectionId; label: string }[] = useMemo(
    () => [
      { id: "appearance", label: t("settings.appearance") },
      { id: "shortcuts", label: t("settings.shortcuts") },
      { id: "terminal", label: t("settings.terminal") },
      { id: "skillsDir", label: t("settings.skillsDir") },
      { id: "skillssh", label: t("settings.skillssh") },
      { id: "tuis", label: t("settings.tuis") },
      { id: "prelaunch", label: t("settings.prelaunch") },
      { id: "cli", label: t("settings.cli") },
      { id: "graphify", label: t("settings.graphify") },
      { id: "orchestrator", label: t("settings.orchestrator") },
      { id: "routing", label: t("settings.routing") },
      { id: "sync", label: t("settings.sync") },
      { id: "updates", label: t("settings.updates") },
    ],
    [t]
  );

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

  return (
    <>
      <nav className="flex flex-col w-52 shrink-0 min-h-0
        border-r border-gray-200 dark:border-white/[0.08]
        bg-gray-100/60 dark:bg-surface-sunken">
        <div className="flex-1 min-h-0 cc-scroll p-2 flex flex-col gap-0.5">
          {sections.map((s) => (
            <Button variant="custom"
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`cc-t flex items-center gap-2.5 w-full h-8 px-1.5 rounded-md text-left
                text-[13px] leading-[18px]
                ${s.id === section
                  ? "bg-accent-500 text-white font-medium"
                  : "text-gray-800 dark:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-white/[0.06]"}`}
            >
              <SectionIcon id={s.id} />
              <span className="truncate">{s.label}</span>
            </Button>
          ))}
        </div>
      </nav>

      <div className="flex-1 min-w-0 min-h-0 cc-scroll px-6 py-5">
        {section === "appearance" && (
          <SettingsSection title={t("settings.appearance")} description={t("settings.appearance.desc")}>
            <SettingsGroup>
              <SettingsRow label={t("settings.theme")}>
                <ThemeToggle />
              </SettingsRow>
              <SettingsRow label={t("settings.language")}>
                <Select
                  value={i18n.language}
                  onChange={(e) => handleLanguage(e.target.value)}
                  variant="minimal"
                  size="sm"
                  options={[...LANGUAGE_OPTIONS]}
                />
              </SettingsRow>
              <RenderingSetting />
              <NotificationsSetting />
              <SandboxSetting />
            </SettingsGroup>
          </SettingsSection>
        )}

        {section === "shortcuts" && <ShortcutsSection />}
        {section === "terminal" && <TerminalSection />}

        {section === "skillsDir" && (
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

        {section === "tuis" && (
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
                            onClick={() => removeCustomAgent(agent.id)}
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

        {section === "skillssh" && <SkillsShSection />}
        {section === "prelaunch" && <PrelaunchSection />}
        {section === "cli" && <CliInstallSection />}
        {section === "graphify" && <GraphifySection />}
        {section === "orchestrator" && <OrchestratorSection />}
        {section === "routing" && <RoutingSection />}
        {section === "sync" && <SyncSection />}
        {section === "updates" && <UpdatesSection />}
      </div>
    </>
  );
}
