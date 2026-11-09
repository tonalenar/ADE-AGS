import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useUiStore, type StartMode } from "@/app/uiStore";
import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";

import { AccessMenu } from "./AccessMenu";
import { AgentModelPicker } from "./AgentModelPicker";
import { setChatWidth, useChatLook } from "./chatLook";
import { accessModesFor, planSupported } from "./chatModel";
import { loadChatPrefs, saveChatPrefs, type ChatPrefs, type ChatWidth, type FollowUpBehavior } from "./chatPrefs";
import { loadOrMigrateChatThreadEnvMode, saveChatThreadEnvMode, type ChatThreadEnvMode, type ChatWorktreeSubmodules } from "./chatWorkspacePrefs";
import { isLocalAcpAgent, isStructuredAgent } from "./structured/model";
import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { SHELL_AGENT_ID } from "@/features/tabs/types";

/**
 * A seção "Modo chat" das Configurações (prancheta 5): ligar o modo e onde o app abre; como as
 * conversas novas começam (agente, permissões, worktree, Plano, sem terminal); e a largura da
 * conversa. Os padrões das conversas são os mesmos valores que o composer lembra (`chatPrefs`):
 * mudar aqui ou lá dá no mesmo.
 */
export function ChatModeSetting() {
  const { t } = useTranslation();
  const chatMode = useUiStore((s) => s.chatMode);
  const setChatMode = useUiStore((s) => s.setChatMode);
  const startMode = useUiStore((s) => s.startMode);
  const setStartMode = useUiStore((s) => s.setStartMode);
  const width = useChatLook((s) => s.width);
  const available = useAvailableAgents({ includeLocalAcp: true });
  const agents = useMemo(() => available.filter((a) => a.id !== SHELL_AGENT_ID), [available]);
  const [prefs, setPrefs] = useState<ChatPrefs>(loadChatPrefs);
  const [workspaceMode, setWorkspaceMode] = useState<ChatThreadEnvMode | "auto">(() => loadOrMigrateChatThreadEnvMode() ?? "auto");
  const [worktreeSubmodules, setWorktreeSubmodules] = useState<ChatWorktreeSubmodules | "auto">(() => loadChatPrefs().worktreeSubmodules ?? "auto");
  const update = (patch: Partial<ChatPrefs>) => {
    // Do disco: a largura e o composer gravam nas mesmas preferências.
    const next = { ...loadChatPrefs(), ...patch };
    setPrefs(next);
    saveChatPrefs(next);
  };
  const agentId = prefs.agentId ?? agents[0]?.id ?? null;
  const localAcp = !!agentId && isLocalAcpAgent(agentId);
  const viaProtocol = !!agentId && (isLocalAcpAgent(agentId) || (prefs.structured && isStructuredAgent(agentId)));
  const modes = agentId ? accessModesFor(agentId, viaProtocol) : ["ask" as const];
  const access = modes.includes(prefs.access) ? prefs.access : modes[0] ?? "ask";
  const setDefaultWorkspaceMode = (mode: ChatThreadEnvMode | "auto") => {
    setWorkspaceMode(mode);
    saveChatThreadEnvMode(mode === "auto" ? null : mode);
  };

  return (
    <>
      <SettingsSection title={t("chat.settings.onOpen")}>
        <SettingsGroup>
          <SettingsToggleRow label={t("chat.settings.toggle")} description={t("chat.settings.toggleHint")}
            checked={chatMode} onChange={setChatMode} />
          <SettingsRow label={t("chat.settings.startMode")} hint={t("chat.settings.startModeHint")}>
            <ChatSegmented<StartMode> label={t("chat.settings.startMode")} value={startMode}
              onChange={(mode) => setStartMode(mode === startMode ? null : mode)}
              options={[
                { value: "chat", label: t("chat.mode.chat") },
                { value: "tabs", label: t("canvas.mode.tabs") },
                { value: "canvas", label: t("canvas.mode.canvas") },
              ]} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("chat.settings.newConversations")}>
        <SettingsGroup>
          <SettingsRow label={t("chat.settings.defaultAgent")} hint={t("chat.settings.defaultAgentHint")}>
            <span className="rounded-lg border border-gray-200 dark:border-white/10">
              <AgentModelPicker agents={agents} placement="below" showAccount={!localAcp}
                value={{ agentId, model: localAcp ? null : prefs.model, effort: localAcp ? null : prefs.effort, account: localAcp ? null : prefs.accountId }}
                onChange={(v) => {
                  const customAcp = isLocalAcpAgent(v.agentId ?? "");
                  update({ agentId: v.agentId, model: customAcp ? null : v.model, effort: customAcp ? null : v.effort, accountId: customAcp ? null : v.account, plan: customAcp ? false : prefs.plan });
                }} />
            </span>
          </SettingsRow>
          <SettingsRow label={t("chat.settings.defaultAccess")} hint={t("chat.settings.defaultAccessHint")}>
            <span className="rounded-lg border border-gray-200 dark:border-white/10 px-1">
              <AccessMenu placement="below" value={access} available={modes} onChange={(next) => update({ access: next })} />
            </span>
          </SettingsRow>
          <SettingsRow label={t("chat.settings.worktree")} hint={t("chat.workspace.preferenceHint")}>
            <ChatSegmented<ChatThreadEnvMode | "auto"> label={t("chat.settings.worktree")} value={workspaceMode}
              onChange={setDefaultWorkspaceMode}
              options={[
                { value: "auto", label: t("chat.workspace.auto") },
                { value: "local", label: t("chat.new.currentCheckout") },
                { value: "worktree", label: t("chat.workspace.newWorktree") },
              ]} />
          </SettingsRow>
          <SettingsRow label={t("chat.settings.worktreeSubmodules")} hint={t("chat.settings.worktreeSubmodulesHint")}>
            <ChatSegmented<ChatWorktreeSubmodules | "auto"> label={t("chat.settings.worktreeSubmodules")} value={worktreeSubmodules}
              onChange={(mode) => {
                setWorktreeSubmodules(mode);
                update({ worktreeSubmodules: mode === "auto" ? null : mode });
              }}
              options={[
                { value: "auto", label: t("chat.workspace.auto") },
                { value: "none", label: t("chat.workspace.submodules.none") },
                { value: "top-level", label: t("chat.workspace.submodules.topLevel") },
                { value: "recursive", label: t("chat.workspace.submodules.recursive") },
              ]} />
          </SettingsRow>
          <SettingsToggleRow label={t("chat.settings.plan")} description={t("chat.settings.planHint")}
            checked={prefs.plan} disabled={!!agentId && !planSupported(agentId, viaProtocol)} onChange={(plan) => update({ plan })} />
          <SettingsToggleRow label={t("chat.settings.structured")} description={t("chat.settings.structuredHint")}
            checked={localAcp || prefs.structured} disabled={localAcp} onChange={(structured) => update({ structured })} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("chat.settings.composer")}>
        <SettingsGroup>
          <SettingsToggleRow label={t("chat.settings.showSkillsInSlashMenu")} description={t("chat.settings.showSkillsInSlashMenuHint")}
            checked={prefs.showSkillsInSlashMenu} onChange={(showSkillsInSlashMenu) => update({ showSkillsInSlashMenu })} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("chat.settings.look")}>
        <SettingsGroup>
          <SettingsRow label={t("chat.settings.width")} hint={t("chat.settings.widthHint")}>
            <ChatSegmented<ChatWidth> label={t("chat.settings.width")} value={width} onChange={setChatWidth}
              options={[
                { value: "normal", label: t("chat.settings.widthNormal") },
                { value: "wide", label: t("chat.settings.widthWide") },
                { value: "full", label: t("chat.settings.widthFull") },
              ]} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("chat.settings.followUp")}>
        <SettingsGroup>
          <SettingsRow label={t("chat.settings.followUpBehavior")} hint={t("chat.settings.followUpBehaviorHint")}>
            <ChatSegmented<FollowUpBehavior> label={t("chat.settings.followUpBehavior")} value={prefs.followUpBehavior}
              onChange={(followUpBehavior) => update({ followUpBehavior })}
              options={[
                { value: "steer", label: t("chat.settings.followUpSteer") },
                { value: "queue", label: t("chat.settings.followUpQueue") },
              ]} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </>
  );
}
