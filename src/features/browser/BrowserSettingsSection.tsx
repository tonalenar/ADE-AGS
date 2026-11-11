import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { ChatSwitch, SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { BrowserSearchSetting } from "./BrowserSearchSetting";
import { BrowserImportSetting } from "./BrowserImportSetting";
import { readBrowserPreferences, saveBrowserPreferences, type BrowserPreferences } from "./browserPreferences";

export function BrowserSettingsSection() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<BrowserPreferences>(readBrowserPreferences);
  const [advanced, setAdvanced] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const update = (patch: Partial<BrowserPreferences>) => {
    const next = { ...preferences, ...patch };
    try {
      saveBrowserPreferences(next);
      setPreferences(next);
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title={t("settings.browser.behavior.title")} description={t("settings.browser.behavior.description")}>
        <SettingsGroup>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id="browser-auto-show" className="text-[14px] font-medium text-gray-900 dark:text-white">{t("settings.browser.autoShow")}</span>
              <span className="text-[13px] text-gray-500 dark:text-white/50">{t("settings.browser.autoShowHint")}</span>
            </span>
            <ChatSwitch labelId="browser-auto-show" checked={preferences.autoShowFloatingPreview}
              onChange={(checked) => update({ autoShowFloatingPreview: checked })} />
          </div>
          {saveError && <p role="alert" className="m-0 px-4 pb-3 text-[12px] text-red-600 dark:text-red-400">{t("settings.browser.saveError")}</p>}
        </SettingsGroup>
      </SettingsSection>
      <BrowserSearchSetting />
      <BrowserImportSetting />
      <SettingsSection title={t("settings.browser.recording.title")} description={t("settings.browser.recording.description")}>
        <SettingsGroup>
          <SettingsRow label={t("settings.browser.recording.fps")} hint={t("settings.browser.recording.fpsHint")}>
            <PopupSelect value={String(preferences.maxRecordingFps)} aria-label={t("settings.browser.recording.fps")}
              onChange={(event) => update({ maxRecordingFps: event.target.value === "60" ? 60 : 30 })}>
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
            </PopupSelect>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <section className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03]">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-[14px] font-medium text-gray-900 dark:text-white">
          {t("settings.browser.advanced")}
          <span aria-hidden="true" className="text-gray-400">{advanced ? "−" : "+"}</span>
        </button>
        {advanced && <p className="m-0 border-t border-gray-200 px-4 py-3 text-[13px] leading-5 text-gray-500 dark:border-white/[0.08] dark:text-white/50">
          {t("settings.browser.advancedHint", { width: 1920, height: 1080 })}
        </p>}
      </section>
    </div>
  );
}
