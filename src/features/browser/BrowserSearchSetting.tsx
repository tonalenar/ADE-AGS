import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import {
  isValidCustomSearchUrl,
  readBrowserSearchPreferences,
  saveBrowserSearchPreferences,
  type BrowserSearchEngine,
  type BrowserSearchPreferences,
} from "./searchPreferences";

export function BrowserSearchSetting() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<BrowserSearchPreferences>(readBrowserSearchPreferences);
  const [template, setTemplate] = useState(preferences.customUrl);
  const [error, setError] = useState<"invalid" | "storage" | null>(null);

  const selectEngine = (engine: BrowserSearchEngine) => {
    const next = { ...preferences, engine };
    setPreferences(next);
    setError(null);
    if (engine === "custom" && !isValidCustomSearchUrl(template)) {
      setError("invalid");
      return;
    }
    try {
      const saved = { ...next, customUrl: template };
      saveBrowserSearchPreferences(saved);
      setPreferences(saved);
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "storage" ? "storage" : "invalid");
    }
  };

  const saveTemplate = () => {
    const next = { ...preferences, engine: "custom" as const, customUrl: template };
    try {
      saveBrowserSearchPreferences(next);
      setPreferences(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "storage" ? "storage" : "invalid");
    }
  };

  const selectLinkTarget = (linkTarget: BrowserSearchPreferences["linkTarget"]) => {
    const next = { ...preferences, customUrl: template, linkTarget };
    if (next.engine === "custom" && !isValidCustomSearchUrl(template)) {
      setError("invalid");
      return;
    }
    try {
      saveBrowserSearchPreferences(next);
      setPreferences(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "storage" ? "storage" : "invalid");
    }
  };

  return (
    <SettingsSection title={t("settings.browserSearch.title")} description={t("settings.browserSearch.description")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.browserSearch.engine")}>
          <PopupSelect value={preferences.engine} aria-label={t("settings.browserSearch.engine")}
            onChange={(event) => selectEngine(event.target.value as BrowserSearchEngine)}>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="brave">Brave Search</option>
            <option value="kagi">Kagi</option>
            <option value="ecosia">Ecosia</option>
            <option value="custom">{t("settings.browserSearch.custom")}</option>
          </PopupSelect>
        </SettingsRow>
        <SettingsRow label={t("settings.browserSearch.linkTarget")} hint={t("settings.browserSearch.linkTargetHint")}>
          <PopupSelect value={preferences.linkTarget} aria-label={t("settings.browserSearch.linkTarget")}
            onChange={(event) => selectLinkTarget(event.target.value as BrowserSearchPreferences["linkTarget"])}>
            <option value="system">{t("settings.browserSearch.system")}</option>
            <option value="app">{t("settings.browserSearch.app")}</option>
          </PopupSelect>
        </SettingsRow>
        {preferences.engine === "custom" && (
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <label htmlFor="browser-search-template" className="text-[14px] font-medium text-gray-900 dark:text-white">
              {t("settings.browserSearch.template")}
            </label>
            <div className="flex items-center gap-2">
              <input id="browser-search-template" value={template} maxLength={2048}
                onChange={(event) => { setTemplate(event.target.value); setError(null); }}
                placeholder="https://example.com/search?q=%s"
                className="cc-t h-9 min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent-500 dark:border-white/15 dark:bg-gray-950 dark:text-gray-100 dark:placeholder:text-white/35" />
              <button type="button" onClick={saveTemplate} disabled={!isValidCustomSearchUrl(template)}
                className="cc-t h-9 shrink-0 rounded-lg bg-accent-600 px-3 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-45">
                {t("settings.browserSearch.save")}
              </button>
            </div>
            <p role={error ? "alert" : undefined} className={`m-0 text-[11px] leading-4 ${error ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-white/45"}`}>
              {error ? t(error === "storage" ? "settings.browserSearch.storageError" : "settings.browserSearch.invalid") : t("settings.browserSearch.templateHint")}
            </p>
          </div>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
