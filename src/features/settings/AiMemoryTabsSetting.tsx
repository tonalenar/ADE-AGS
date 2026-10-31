import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { SettingsToggleRow } from "@/features/settings/SettingsSection";

/** Aplica-se apenas ao nascimento de novas abas; não reinicia terminais. */
export function AiMemoryTabsSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    getSetting("ai_memory_tabs_enabled").then((value) => setEnabled(value !== "false")).catch(() => {});
  }, []);
  return (
    <SettingsToggleRow
      checked={enabled}
      onChange={(value) => {
        setEnabled(value);
        setSetting("ai_memory_tabs_enabled", value ? "true" : "false").catch(console.error);
      }}
      label={t("settings.aiMemoryTabs.label")}
      description={t("settings.aiMemoryTabs.desc")}
    />
  );
}
