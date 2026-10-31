import { useState } from "react";
import { useTranslation } from "react-i18next";

import { loadChatPrefs, saveChatPrefs } from "@/features/chat/chatPrefs";

import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "./SettingsSection";

/**
 * Worktrees (prancheta 5): onde as conversas, as missões e a frota trabalham sem mexer no seu
 * checkout. O liga/desliga é o mesmo do composer e da seção Modo chat (`chatPrefs.worktree`).
 */
export function WorktreesSection() {
  const { t } = useTranslation();
  const [worktree, setWorktree] = useState(() => loadChatPrefs().worktree);
  const toggle = (next: boolean) => {
    setWorktree(next);
    saveChatPrefs({ ...loadChatPrefs(), worktree: next });
  };
  return (
    <SettingsSection title={t("settings.worktrees.where")}>
      <SettingsGroup>
        <SettingsToggleRow label={t("chat.settings.worktree")} description={t("chat.settings.worktreeHint")} checked={worktree} onChange={toggle} />
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
