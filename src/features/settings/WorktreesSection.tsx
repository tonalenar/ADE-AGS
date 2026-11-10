import { useState } from "react";
import { useTranslation } from "react-i18next";

import { loadOrMigrateChatThreadEnvMode, saveChatThreadEnvMode, type ChatThreadEnvMode } from "@/features/chat/chatWorkspacePrefs";

import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection } from "./SettingsSection";

/**
 * Worktrees (prancheta 5): onde as conversas, as missões e a frota trabalham sem mexer no seu
 * checkout. O padrão da máquina é compartilhado com a seção Modo chat; projetos podem herdar de `t3.json`.
 */
export function WorktreesSection() {
  const { t } = useTranslation();
  const [workspaceMode, setWorkspaceMode] = useState<ChatThreadEnvMode | "auto">(() => loadOrMigrateChatThreadEnvMode() ?? "auto");
  const changeWorkspaceMode = (mode: ChatThreadEnvMode | "auto") => {
    setWorkspaceMode(mode);
    saveChatThreadEnvMode(mode === "auto" ? null : mode);
  };
  return (
    <SettingsSection title={t("settings.worktrees.where")}>
      <SettingsGroup>
        <SettingsRow label={t("chat.settings.worktree")} hint={t("chat.workspace.preferenceHint")}>
          <ChatSegmented<ChatThreadEnvMode | "auto"> label={t("chat.settings.worktree")} value={workspaceMode}
            onChange={changeWorkspaceMode}
            options={[
              { value: "auto", label: t("chat.workspace.auto") },
              { value: "local", label: t("chat.new.currentCheckout") },
              { value: "worktree", label: t("chat.workspace.newWorktree") },
            ]} />
        </SettingsRow>
        <SettingsRow label={t("settings.worktrees.chat")} hint={t("settings.worktrees.chatHint")}>
          <code className="text-[12px] text-gray-500 dark:text-white/50">chat-worktrees/</code>
        </SettingsRow>
        <SettingsRow label={t("settings.worktrees.runs")} hint={t("settings.worktrees.runsHint")}>
          <code className="text-[12px] text-gray-500 dark:text-white/50">ags worktrees prune --dry-run</code>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
