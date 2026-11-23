import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";

import { loadChatPrefs, saveChatPrefs, useChatPrefs } from "./chatPrefs";

/** "Escrita" na página Chat: corretor ortográfico nativo e a sugestão do próximo prompt no composer. */
export function ComposerTextSetting() {
  const { t } = useTranslation();
  const { spellcheck, promptSuggestions } = useChatPrefs();

  return (
    <SettingsSection title={t("chat.settings.writingSection")}>
      <SettingsGroup>
        <SettingsToggleRow label={t("chat.settings.spellcheck")} description={t("chat.settings.spellcheck.hint")}
          checked={spellcheck} onChange={(next) => saveChatPrefs({ ...loadChatPrefs(), spellcheck: next })} />
        <SettingsToggleRow label={t("chat.settings.promptSuggestions")} description={t("chat.settings.promptSuggestions.hint")}
          checked={promptSuggestions} onChange={(next) => saveChatPrefs({ ...loadChatPrefs(), promptSuggestions: next })} />
      </SettingsGroup>
    </SettingsSection>
  );
}
