import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { DEFAULT_COMMIT_WRITING_PREFERENCES, readCommitWritingPreferences, writeCommitWritingPreferences } from "@/features/scm/writingStyle";

export function SourceControlSettings() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(readCommitWritingPreferences);
  const update = (patch: Partial<typeof preferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    writeCommitWritingPreferences(next);
  };
  const reset = () => {
    setPreferences(DEFAULT_COMMIT_WRITING_PREFERENCES);
    writeCommitWritingPreferences(DEFAULT_COMMIT_WRITING_PREFERENCES);
  };

  return (
    <SettingsSection title={t("settings.sourceControl.writing.title")} description={t("settings.sourceControl.writing.desc")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.sourceControl.style")} hint={t("settings.sourceControl.style.hint")}>
          <select value={preferences.mode} onChange={(event) => update({ mode: event.target.value as typeof preferences.mode })}
            aria-label={t("settings.sourceControl.style")} className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-2 py-1 text-[13px] text-gray-900 dark:text-white">
            <option value="conventional">{t("settings.sourceControl.style.conventional")}</option>
            <option value="repository">{t("settings.sourceControl.style.repository")}</option>
            <option value="plain">{t("settings.sourceControl.style.plain")}</option>
          </select>
        </SettingsRow>
        <SettingsRow label={t("settings.sourceControl.language")}>
          <select value={preferences.language} onChange={(event) => update({ language: event.target.value as typeof preferences.language })}
            aria-label={t("settings.sourceControl.language")} className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-2 py-1 text-[13px] text-gray-900 dark:text-white">
            <option value="pt-BR">{t("settings.sourceControl.language.ptBR")}</option>
            <option value="en">{t("settings.sourceControl.language.en")}</option>
            <option value="es">{t("settings.sourceControl.language.es")}</option>
          </select>
        </SettingsRow>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <label htmlFor="scm-writing-instructions" className="text-[14px] font-medium text-gray-900 dark:text-white">{t("settings.sourceControl.instructions")}</label>
          <textarea id="scm-writing-instructions" value={preferences.customInstructions} maxLength={1000}
            onChange={(event) => update({ customInstructions: event.target.value })}
            placeholder={t("settings.sourceControl.instructions.placeholder")}
            className="min-h-20 resize-y rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/4 px-3 py-2 text-[13px] text-gray-900 dark:text-white placeholder:text-gray-400 outline-none focus:border-accent-500" />
          <button type="button" onClick={reset} className="self-start text-[12px] text-accent-600 dark:text-accent-400 hover:underline">{t("settings.sourceControl.reset")}</button>
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
