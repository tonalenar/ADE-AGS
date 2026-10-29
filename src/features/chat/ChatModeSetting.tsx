import { useTranslation } from "react-i18next";

import { useUiStore } from "@/app/uiStore";
import { SettingsGroup, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";

/** Liga o modo chat (experimental). Desligar devolve a janela às abas/canvas. */
export function ChatModeSetting() {
  const { t } = useTranslation();
  const chatMode = useUiStore((s) => s.chatMode);
  const setChatMode = useUiStore((s) => s.setChatMode);
  return (
    <SettingsSection title={t("chat.settings.title")} description={t("chat.settings.desc")}>
      <SettingsGroup>
        <SettingsToggleRow label={t("chat.settings.toggle")} description={t("chat.settings.toggleHint")}
          checked={chatMode} onChange={setChatMode} />
      </SettingsGroup>
    </SettingsSection>
  );
}
