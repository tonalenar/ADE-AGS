import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useUiStore, type StartMode } from "@/app/uiStore";
import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";

import { AccessMenu } from "./AccessMenu";
import { AgentModelPicker } from "./AgentModelPicker";
import { setChatWidth, useChatLook } from "./chatLook";
import { accessModesFor, planSupported } from "./chatModel";
import { loadChatPrefs, saveChatPrefs, type ChatPrefs, type ChatWidth } from "./chatPrefs";
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
  const available = useAvailableAgents();
  const agents = useMemo(() => available.filter((a) => a.id !== SHELL_AGENT_ID), [available]);
  const [prefs, setPrefs] = useState<ChatPrefs>(loadChatPrefs);
  const update = (patch: Partial<ChatPrefs>) => {
    // Do disco: a largura e o composer gravam nas mesmas preferências.
    const next = { ...loadChatPrefs(), ...patch };
    setPrefs(next);
    saveChatPrefs(next);
  };
  const agentId = prefs.agentId ?? agents[0]?.id ?? null;
  const modes = agentId ? accessModesFor(agentId) : ["ask" as const];
  const access = modes.includes(prefs.access) ? prefs.access : modes[0] ?? "ask";

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
              <AgentModelPicker agents={agents}
                value={{ agentId, model: prefs.model, effort: prefs.effort, account: prefs.accountId }}
                onChange={(v) => update({ agentId: v.agentId, model: v.model, effort: v.effort, accountId: v.account })} />
            </span>
          </SettingsRow>
          <SettingsRow label={t("chat.settings.defaultAccess")} hint={t("chat.settings.defaultAccessHint")}>
            <span className="rounded-lg border border-gray-200 dark:border-white/10 px-1">
              <AccessMenu value={access} available={modes} onChange={(next) => update({ access: next })} />
            </span>
          </SettingsRow>
          <SettingsToggleRow label={t("chat.settings.worktree")} description={t("chat.settings.worktreeHint")}
            checked={prefs.worktree} onChange={(worktree) => update({ worktree })} />
          <SettingsToggleRow label={t("chat.settings.plan")} description={t("chat.settings.planHint")}
            checked={prefs.plan} disabled={!!agentId && !planSupported(agentId)} onChange={(plan) => update({ plan })} />
          <SettingsToggleRow label={t("chat.settings.structured")} description={t("chat.settings.structuredHint")}
            checked={prefs.structured} onChange={(structured) => update({ structured })} />
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
    </>
  );
}
