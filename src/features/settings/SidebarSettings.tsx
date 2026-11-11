import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";
import { saveWorkingShelf, useWorkingShelf } from "@/features/settings/sidebarPreferences";

/**
 * Configurações → Geral → Barra lateral. Hoje tem a seção Trabalhando; o agrupamento por projeto já é o da
 * barra (sempre por projeto), então não vira ajuste aqui.
 */
export function SidebarSettings() {
  const { t } = useTranslation();
  const workingShelf = useWorkingShelf();
  return (
    <SettingsSection title={t("settings.sidebar.title")} description={t("settings.sidebar.desc")}>
      <SettingsGroup>
        <SettingsToggleRow
          checked={workingShelf}
          onChange={(value) => saveWorkingShelf(value)}
          label={t("settings.sidebar.working.label")}
          description={t("settings.sidebar.working.desc")}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
