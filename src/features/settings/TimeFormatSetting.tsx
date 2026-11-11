import { useTranslation } from "react-i18next";

import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { saveDisplayPrefs, useDisplayPrefs } from "@/features/settings/displayPreferences";
import type { TimeFormat } from "@/shared/timeFormat";

/** "Exibição" na página Geral (como no T3 Code): o formato de hora que o chat, a barra lateral e a timeline usam. */
export function TimeFormatSetting() {
  const { t } = useTranslation();
  const prefs = useDisplayPrefs();

  return (
    <SettingsSection title={t("settings.display")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.timeFormat.label")} hint={t("settings.timeFormat.hint")}>
          <ChatSegmented<TimeFormat>
            label={t("settings.timeFormat.label")}
            value={prefs.timeFormat}
            onChange={(timeFormat) => saveDisplayPrefs({ ...prefs, timeFormat })}
            options={[
              { value: "locale", label: t("settings.timeFormat.locale") },
              { value: "12-hour", label: t("settings.timeFormat.12h") },
              { value: "24-hour", label: t("settings.timeFormat.24h") },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
