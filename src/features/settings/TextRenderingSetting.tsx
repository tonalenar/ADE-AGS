import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";
import { saveDisplayPrefs, useDisplayPrefs, type DisplayPrefs } from "@/features/settings/displayPreferences";

/**
 * A renderização do texto, na Aparência, abaixo das fontes: a suavização (texto mais fino e cinza) e a
 * quebra de linha dos blocos de código e diffs. Ambas viram atributos do `<html>` que `App.css` lê.
 */
export function TextRenderingSetting() {
  const { t } = useTranslation();
  const prefs = useDisplayPrefs();
  const update = (patch: Partial<DisplayPrefs>) => saveDisplayPrefs({ ...prefs, ...patch });

  return (
    <SettingsSection title={t("settings.text.title")}>
      <SettingsGroup>
        <SettingsToggleRow
          label={t("settings.fontSmoothing.label")}
          description={t("settings.fontSmoothing.hint")}
          checked={prefs.fontSmoothing}
          onChange={(fontSmoothing) => update({ fontSmoothing })}
        />
        <SettingsToggleRow
          label={t("settings.codeWrap.label")}
          description={t("settings.codeWrap.hint")}
          checked={prefs.codeWrap}
          onChange={(codeWrap) => update({ codeWrap })}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
