import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSetting, setSetting } from "@/shared/ipc/settings";
import { SettingsToggleRow } from "@/features/settings/SettingsSection";

/** La clave que lee `notifier.rs`. Prendido salvo que diga "false". */
const NOTIFICATIONS_KEY = "notifications.enabled";

/**
 * Avisos del sistema cuando una misión termina o falla, un agente espera una aprobación o
 * una cuenta tiene un problema. Solo llegan con la app en segundo plano (ver `notifier.rs`).
 */
export function NotificationsSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    getSetting(NOTIFICATIONS_KEY).then((v) => setEnabled(v !== "false")).catch(() => {});
  }, []);

  return (
    <SettingsToggleRow
      checked={enabled}
      onChange={(value) => {
        setEnabled(value);
        setSetting(NOTIFICATIONS_KEY, value ? "true" : "false").catch(console.error);
      }}
      label={t("settings.notifications.label")}
      description={t("settings.notifications.desc")}
    />
  );
}
