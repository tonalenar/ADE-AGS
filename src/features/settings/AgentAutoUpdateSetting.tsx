import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AUTO_UPDATE_SETTING_KEY, isAutoUpdateEnabled } from "@/features/agents/updatePolicy";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { persistToggle, toastToggleError } from "@/features/settings/persistToggle";
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
        void persistToggle(value, setEnabled, () => setSetting(AUTO_UPDATE_SETTING_KEY, value ? "true" : "false"), (e) => toastToggleError(t("settings.agentUpdates.label"), e));
      }}
      label={t("settings.agentUpdates.label")}
      description={t("settings.agentUpdates.desc")}
    />
  );
}
