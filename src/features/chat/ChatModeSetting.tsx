import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useUiStore } from "@/app/uiStore";
import { SettingsGroup, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";

import { loadChatPrefs, saveChatPrefs, type ChatPrefs } from "./chatPrefs";

/**
 * A seção "Modo chat" das Configurações (prancheta 5): ligar o modo (experimental; desligar devolve
 * a janela às abas/canvas) e como as conversas novas começam. Os dois últimos são os mesmos valores
 * que o composer lembra (`chatPrefs`): mudar aqui ou lá dá no mesmo.
 */
export function ChatModeSetting() {
  const { t } = useTranslation();
  const chatMode = useUiStore((s) => s.chatMode);
  const setChatMode = useUiStore((s) => s.setChatMode);
  const [prefs, setPrefs] = useState<ChatPrefs>(loadChatPrefs);
  const update = (patch: Partial<ChatPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveChatPrefs(next);
  };
  return (
    <SettingsSection title={t("chat.settings.title")} description={t("chat.settings.desc")}>
      <SettingsGroup>
        <SettingsToggleRow label={t("chat.settings.toggle")} description={t("chat.settings.toggleHint")}
          checked={chatMode} onChange={setChatMode} />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsToggleRow label={t("chat.settings.worktree")} description={t("chat.settings.worktreeHint")}
          checked={prefs.worktree} onChange={(worktree) => update({ worktree })} />
        <SettingsToggleRow label={t("chat.settings.plan")} description={t("chat.settings.planHint")}
          checked={prefs.plan} onChange={(plan) => update({ plan })} />
        <SettingsToggleRow label={t("chat.settings.structured")} description={t("chat.settings.structuredHint")}
          checked={prefs.structured} onChange={(structured) => update({ structured })} />
      </SettingsGroup>
    </SettingsSection>
  );
}
