import { useTranslation } from "react-i18next";

import { saveConfirmPrefs, useConfirmPrefs, type ConfirmPrefs } from "@/features/settings/confirmPreferences";
import { SettingsGroup, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";

/** Cada confirmação: a chave da preferência e os textos (chaves i18n) que a tela mostra. */
const ROWS: readonly { key: keyof ConfirmPrefs; label: string; desc: string }[] = [
  { key: "unpin", label: "settings.confirm.unpin.label", desc: "settings.confirm.unpin.desc" },
  { key: "archive", label: "settings.confirm.archive.label", desc: "settings.confirm.archive.desc" },
  { key: "delete", label: "settings.confirm.delete.label", desc: "settings.confirm.delete.desc" },
];

/**
 * Configurações → Geral → Confirmações: pedir confirmação antes de desafixar, arquivar ou excluir (concluir)
 * uma conversa da barra lateral. Excluir vem ligado por padrão.
 */
export function ConfirmationsSetting() {
  const { t } = useTranslation();
  const prefs = useConfirmPrefs();
  return (
    <SettingsSection title={t("settings.confirm.title")} description={t("settings.confirm.desc")}>
      <SettingsGroup>
        {ROWS.map((row) => (
          <SettingsToggleRow
            key={row.key}
            checked={prefs[row.key]}
            onChange={(value) => saveConfirmPrefs({ ...prefs, [row.key]: value })}
            label={t(row.label)}
            description={t(row.desc)}
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
