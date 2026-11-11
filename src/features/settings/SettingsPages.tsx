import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, FolderIcon } from "neogestify-ui-components";

import i18n, { setLanguage } from "@/i18n/index";
import { LANGUAGE_OPTIONS, persistLocale } from "@/i18n/locale";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useTabsStore } from "@/features/tabs/store";
import { useSkillsStore } from "@/features/skills/store";
import { ContasSection } from "@/features/accounts/ContasSection";
import { DetectedAgents } from "@/features/agents/DetectedAgents";
import { LocalAcpSection } from "@/features/agents/LocalAcpSection";
import { GraphifySection } from "@/features/graphify/GraphifySection";
import { SharedMemoryPanel } from "@/features/memory/SharedMemoryPanel";
import { AiMemoryPanel } from "@/features/memory/AiMemoryPanel";
import { SkillsShSection } from "@/features/marketplace/SkillsShSection";
import { OrchestratorSection } from "@/features/orchestrator/OrchestratorSection";
import { RoutingSection } from "@/features/runs/RoutingSection";
import { PrelaunchSection } from "@/features/prelaunch/PrelaunchSection";
import { TerminalSection } from "@/features/terminal/TerminalSection";
import { PermissionsSection } from "@/features/chat/permissions/PermissionsSection";
import { ChatModeSetting } from "@/features/chat/ChatModeSetting";
import { SendShortcutSetting } from "@/features/chat/SendShortcutSetting";
import { ToolCallsSetting } from "@/features/chat/ToolCallsSetting";
import { ClaudeAutoCompactSetting } from "@/features/chat/ClaudeAutoCompactSetting";
import { SnoozeOptionsSetting } from "@/features/chat/SnoozeOptionsSetting";
import { BrowserSearchSetting } from "@/features/browser/BrowserSearchSetting";
import { BrowserImportSetting } from "@/features/browser/BrowserImportSetting";
import { UpdatesSection } from "@/features/updates/UpdatesSection";
import { SyncSection } from "@/features/sync/SyncSection";
import { ShortcutsSection } from "@/features/settings/ShortcutsSection";
import { DecisionsSection } from "@/features/settings/DecisionsSection";
import { CliInstallSection } from "@/features/settings/CliInstallSection";
import { DevicesSection } from "@/features/settings/DevicesSection";
import { WorktreesSection } from "@/features/settings/WorktreesSection";
import { NotificationsSetting } from "@/features/settings/NotificationsSetting";
import { InAppNoticesSetting } from "@/features/settings/InAppNoticesSetting";
import { ConfirmationsSetting } from "@/features/settings/ConfirmationsSetting";
import { SidebarSettings } from "@/features/settings/SidebarSettings";
import { ScheduledTasksSection } from "@/features/settings/ScheduledTasksSection";
import { AiMemoryTabsSetting } from "@/features/settings/AiMemoryTabsSetting";
import { AgentAutoUpdateSetting } from "@/features/settings/AgentAutoUpdateSetting";
import { SandboxSetting } from "@/features/settings/SandboxSetting";
import { RenderingSetting } from "@/features/settings/RenderingSetting";
import { FontPreferencesSetting } from "@/features/settings/FontPreferencesSetting";
import { AppearanceModeSetting } from "@/features/settings/AppearanceModeSetting";
import { ThemePreferencesSetting } from "@/features/settings/ThemePreferencesSetting";
import { MotionPreferencesSetting } from "@/features/settings/MotionPreferencesSetting";
import { AppearanceInterfaceSetting } from "@/features/settings/AppearanceInterfaceSetting";
import { TextRenderingSetting } from "@/features/settings/TextRenderingSetting";
import { TimeFormatSetting } from "@/features/settings/TimeFormatSetting";
import { DiffsSetting } from "@/features/settings/DiffsSetting";
import { SettingsAnchor, SettingsGroup, SettingsRow, SettingsSection, SettingsSubTabs } from "@/features/settings/SettingsSection";
import { CustomAgentsSection } from "@/features/settings/CustomAgentsSection";
import type { SettingsPageId } from "@/features/settings/settingsNav";
import { useSettingsTargetStore } from "@/features/settings/settingsTarget";

/**
 * Um cartão só de leitura: título e um texto, sem controle. Para o que a ADE faz mas que não se
 * ajusta aqui (o acesso local, a falta de rede).
 */
function ReadOnlyCard({ anchor, title, text }: { anchor: string; title: string; text: string }) {
  return (
    <SettingsAnchor id={anchor}>
      <SettingsSection title={title}>
        <SettingsGroup>
          <p className="m-0 px-4 py-3.5 text-[13px] leading-[19px] text-gray-600 dark:text-white/60">{text}</p>
        </SettingsGroup>
      </SettingsSection>
    </SettingsAnchor>
  );
}

function GeneralPage() {
  const { t } = useTranslation();
  const handleLanguage = (lang: string) => {
    void setLanguage(lang);
    persistLocale(localStorage, lang);
  };
  return (
    <>
    <SettingsSection title={t("settings.general")} description={t("settings.general.desc")}>
      <SettingsGroup>
        <SettingsAnchor id="general-language">
          <SettingsRow label={t("settings.language")}>
            <PopupSelect value={i18n.language} onChange={(e) => handleLanguage(e.target.value)}>
              {LANGUAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </PopupSelect>
          </SettingsRow>
        </SettingsAnchor>
        <SettingsAnchor id="general-notifications"><NotificationsSetting /></SettingsAnchor>
        <SettingsAnchor id="general-in-app-notifications"><InAppNoticesSetting /></SettingsAnchor>
      </SettingsGroup>
    </SettingsSection>
    <SettingsAnchor id="general-sidebar"><SidebarSettings /></SettingsAnchor>
    <SettingsAnchor id="general-confirmations"><ConfirmationsSetting /></SettingsAnchor>
    <SettingsAnchor id="general-display"><TimeFormatSetting /></SettingsAnchor>
    </>
  );
}

function AppearancePage() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsSection title={t("settings.appearance")} description={t("settings.appearance.desc")}>
        <SettingsGroup>
          <SettingsAnchor id="appearance-mode">
            <SettingsRow label={t("settings.theme")}>
              <AppearanceModeSetting />
            </SettingsRow>
          </SettingsAnchor>
          {/* A composição de GPU não envolve âncora: o componente some fora do Linux, e um bloco vazio
              deixaria um filete sobrando no grupo. */}
          <RenderingSetting />
          <SettingsAnchor id="appearance-motion"><MotionPreferencesSetting /></SettingsAnchor>
        </SettingsGroup>
      </SettingsSection>
      <SettingsAnchor id="appearance-interface"><AppearanceInterfaceSetting /></SettingsAnchor>
      <SettingsAnchor id="appearance-themes"><ThemePreferencesSetting /></SettingsAnchor>
      <SettingsAnchor id="appearance-fonts"><FontPreferencesSetting /></SettingsAnchor>
      <SettingsAnchor id="appearance-text"><TextRenderingSetting /></SettingsAnchor>
    </>
  );
}

function ChatSettingsPage() {
  return (
    <>
      <SettingsAnchor id="chat-mode"><ChatModeSetting /></SettingsAnchor>
      <SettingsAnchor id="chat-composer"><SendShortcutSetting /></SettingsAnchor>
      <SettingsAnchor id="chat-activity"><ToolCallsSetting /></SettingsAnchor>
      <SettingsAnchor id="chat-compact"><ClaudeAutoCompactSetting /></SettingsAnchor>
      <SettingsAnchor id="chat-snooze"><SnoozeOptionsSetting /></SettingsAnchor>
    </>
  );
}

type ProvidersTab = "contas" | "tuis" | "acp";
const PROVIDERS_TABS = ["contas", "tuis", "acp"] as const;

type OrchestratorTab = "orquestrador" | "roteamento" | "prelaunch";
const ORCHESTRATOR_TABS = ["orquestrador", "roteamento", "prelaunch"] as const;

/** Quando a busca pede uma aba desta página, troca para ela (antes de rolar até o bloco). */
function useTabFromTarget<T extends string>(page: SettingsPageId, tabs: readonly T[], setTab: (tab: T) => void): void {
  const target = useSettingsTargetStore((s) => s.target);
  useEffect(() => {
    if (target?.page !== page || !target.tab) return;
    const tab = tabs.find((candidate) => candidate === target.tab);
    if (tab) setTab(tab);
  }, [target, page, tabs, setTab]);
}

/** Provedores e contas: as contas por agente, as TUIs (instaladas e as adicionadas à mão) e os agentes ACP. */
function ProvidersPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ProvidersTab>("contas");
  useTabFromTarget("accounts", PROVIDERS_TABS, setTab);
  return (
    <>
      <SettingsSubTabs<ProvidersTab>
        items={[
          { id: "contas", label: t("settings.accounts") },
          { id: "tuis", label: t("settings.tuis") },
          { id: "acp", label: t("settings.agents.acp.tab") },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "contas" && <SettingsAnchor id="providers-accounts"><ContasSection /></SettingsAnchor>}
      {tab === "tuis" && (
        <SettingsAnchor id="providers-tuis">
          <SettingsSection title={t("settings.tuis")} description={t("settings.tuis.desc")}>
            <SettingsGroup>
              <AgentAutoUpdateSetting />
            </SettingsGroup>
            <DetectedAgents />
            <CustomAgentsSection />
          </SettingsSection>
        </SettingsAnchor>
      )}
      {tab === "acp" && <SettingsAnchor id="providers-acp"><LocalAcpSection /></SettingsAnchor>}
    </>
  );
}

function BrowserPage() {
  return (
    <>
      <SettingsAnchor id="browser-search"><BrowserSearchSetting /></SettingsAnchor>
      <SettingsAnchor id="browser-import"><BrowserImportSetting /></SettingsAnchor>
    </>
  );
}

function DevicesPage() {
  return <SettingsAnchor id="devices-main"><DevicesSection /></SettingsAnchor>;
}

/** Rotinas e tarefas agendadas: os painéis do canvas, embutidos (ver `ScheduledTasksSection`). */
function ScheduledPage() {
  return <SettingsAnchor id="scheduled-main"><ScheduledTasksSection /></SettingsAnchor>;
}

/** Diffs (layout, cores e estado inicial dos trechos): o mesmo layout que o botão da barra do diff muda. */
function DiffsPage() {
  return <SettingsAnchor id="diffs-main"><DiffsSetting /></SettingsAnchor>;
}

function WorktreesPage() {
  return <SettingsAnchor id="worktrees-main"><WorktreesSection /></SettingsAnchor>;
}

function EnvironmentsPage() {
  const { t } = useTranslation();
  return (
    <>
      <ReadOnlyCard anchor="environments-local" title={t("settings.environments.local.title")} text={t("settings.environments.local.desc")} />
      <SettingsAnchor id="environments-sync"><SyncSection /></SettingsAnchor>
    </>
  );
}

function AccessPage() {
  const { t } = useTranslation();
  return (
    <>
      <ReadOnlyCard anchor="access-local" title={t("settings.access.local.title")} text={t("settings.access.local.desc")} />
      <ReadOnlyCard anchor="access-network" title={t("settings.access.network.title")} text={t("settings.access.network.desc")} />
    </>
  );
}

function MaintenancePage() {
  return <SettingsAnchor id="maintenance-updates"><UpdatesSection /></SettingsAnchor>;
}

function LabsPage() {
  return <SettingsAnchor id="labs-graphify"><GraphifySection /></SettingsAnchor>;
}

function MemoryPage() {
  const { t } = useTranslation();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const activeCwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? s.tabs[0]?.cwd ?? "");
  return (
    <>
      <SettingsGroup>
        <SettingsAnchor id="memory-tabs"><AiMemoryTabsSetting /></SettingsAnchor>
      </SettingsGroup>
      <AiMemoryPanel cwd={activeCwd} workspaceId={workspaceId} />
      {workspaceId
        ? <SharedMemoryPanel key={workspaceId} workspaceId={workspaceId} initialTab="workspace" />
        : <p className="text-[12.5px] text-gray-400 dark:text-white/35">{t("settings.memory.noWorkspace")}</p>}
    </>
  );
}

function DecisionsPage() {
  return <SettingsAnchor id="decisions-main"><DecisionsSection /></SettingsAnchor>;
}

function PermissionsPage() {
  return (
    <>
      <SettingsGroup>
        <SettingsAnchor id="permissions-sandbox"><SandboxSetting /></SettingsAnchor>
      </SettingsGroup>
      <SettingsAnchor id="permissions-main"><PermissionsSection /></SettingsAnchor>
    </>
  );
}

function TerminalPage() {
  return <SettingsAnchor id="terminal-main"><TerminalSection /></SettingsAnchor>;
}

/** O orquestrador (Vigia e limites), o roteamento da frota e o pré-lançamento dos agentes. */
function OrchestratorPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<OrchestratorTab>("orquestrador");
  useTabFromTarget("orchestrator", ORCHESTRATOR_TABS, setTab);
  return (
    <>
      <SettingsSubTabs<OrchestratorTab>
        items={[
          { id: "orquestrador", label: t("settings.orchestrator") },
          { id: "roteamento", label: t("settings.routing") },
          { id: "prelaunch", label: t("settings.prelaunch") },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "orquestrador" && <SettingsAnchor id="orchestrator-main"><OrchestratorSection /></SettingsAnchor>}
      {tab === "roteamento" && <SettingsAnchor id="orchestrator-routing"><RoutingSection /></SettingsAnchor>}
      {tab === "prelaunch" && <SettingsAnchor id="orchestrator-prelaunch"><PrelaunchSection /></SettingsAnchor>}
    </>
  );
}

function SkillsPage() {
  const { t } = useTranslation();
  const skillsDir = useSkillsStore((s) => s.skillsDir);
  const setSkillsDir = useSkillsStore((s) => s.setSkillsDir);
  const handleChangeSkillsDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("settings.skillsDir") });
    if (typeof selected === "string" && selected) {
      await setSkillsDir(selected);
    }
  };
  return (
    <>
      <SettingsAnchor id="skills-dir">
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
      </SettingsAnchor>
      <SettingsAnchor id="skills-sh"><SkillsShSection /></SettingsAnchor>
    </>
  );
}

function ShortcutsPage() {
  return <SettingsAnchor id="shortcuts-main"><ShortcutsSection /></SettingsAnchor>;
}

function CliPage() {
  return <SettingsAnchor id="cli-main"><CliInstallSection /></SettingsAnchor>;
}

/** O corpo de cada página, o miolo da tela abaixo do título. Um componente por página: o React remonta ao trocar. */
const PAGE_BODIES: Record<SettingsPageId, () => React.ReactElement> = {
  general: GeneralPage,
  appearance: AppearancePage,
  chat: ChatSettingsPage,
  shortcuts: ShortcutsPage,
  accounts: ProvidersPage,
  browser: BrowserPage,
  devices: DevicesPage,
  scheduled: ScheduledPage,
  diffs: DiffsPage,
  worktrees: WorktreesPage,
  environments: EnvironmentsPage,
  access: AccessPage,
  maintenance: MaintenancePage,
  labs: LabsPage,
  memory: MemoryPage,
  decisions: DecisionsPage,
  permissions: PermissionsPage,
  terminal: TerminalPage,
  orchestrator: OrchestratorPage,
  skills: SkillsPage,
  cli: CliPage,
};

export function SettingsPageBody({ page }: { page: SettingsPageId }) {
  const Body = PAGE_BODIES[page];
  return <Body />;
}
