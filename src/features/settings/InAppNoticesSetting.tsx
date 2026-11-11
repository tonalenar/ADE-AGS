import { useTranslation } from "react-i18next";

import { SettingsToggleRow } from "@/features/settings/SettingsSection";
import { saveInAppNotices, useInAppNotices } from "@/features/settings/inAppNoticesPreference";

/** "Notificações no app": o aviso no canto com a janela em foco. Preferência deste aparelho. */
export function InAppNoticesSetting() {
  const { t } = useTranslation();
  const enabled = useInAppNotices();
  return (
    <SettingsToggleRow
      checked={enabled}
      onChange={(value) => saveInAppNotices(value)}
      label={t("settings.inAppNotifications.label")}
      description={t("settings.inAppNotifications.desc")}
    />
  );
}
