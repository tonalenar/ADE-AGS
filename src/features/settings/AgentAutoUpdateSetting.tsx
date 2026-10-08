import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AUTO_UPDATE_SETTING_KEY, isAutoUpdateEnabled } from "@/features/agents/updatePolicy";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { SettingsToggleRow } from "@/features/settings/SettingsSection";

/** Opt-in: por defecto la app solo avisa que hay una versión nueva de un agente. */
export function AgentAutoUpdateSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    getSetting(AUTO_UPDATE_SETTING_KEY).then((v) => setEnabled(isAutoUpdateEnabled(v))).catch(() => {});
  }, []);

  return (
    <SettingsToggleRow
      checked={enabled}
      onChange={(value) => {
        setEnabled(value);
        setSetting(AUTO_UPDATE_SETTING_KEY, value ? "true" : "false").catch(console.error);
      }}
      label={t("settings.agentUpdates.label")}
      description={t("settings.agentUpdates.desc")}
    />
  );
}
