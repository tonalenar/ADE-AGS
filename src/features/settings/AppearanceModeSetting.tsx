import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "neogestify-ui-components";

import { PopupSelect } from "@/shared/ui/PopupSelect";

import { APPEARANCE_MODE_KEY, readAppearanceMode, setAppearanceMode, type AppearanceMode } from "./appearanceMode";

export function AppearanceModeSetting() {
  const { t } = useTranslation();
  const { setTheme } = useTheme();
  const [mode, setMode] = useState<AppearanceMode>(readAppearanceMode);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === APPEARANCE_MODE_KEY || event.key === "theme") setMode(readAppearanceMode());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  return (
    <PopupSelect value={mode} aria-label={t("settings.theme")} onChange={(event) => {
      const next = event.target.value as AppearanceMode;
      setMode(next);
      setAppearanceMode(next, setTheme);
    }} className="min-w-32">
      <option value="system">{t("settings.theme.system")}</option>
      <option value="light">{t("settings.theme.light")}</option>
      <option value="dark">{t("settings.theme.dark")}</option>
    </PopupSelect>
  );
}

