import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";

import { SettingsGroup, SettingsRow, SettingsSection } from "./SettingsSection";
import {
  DEFAULT_FONT_PREFERENCES,
  readFontPreferences,
  saveFontPreferences,
  type CodeFont,
  type FontPreferences,
  type InterfaceFont,
} from "./fontPreferences";

type FontKind = "interface" | "code";

export function FontPreferencesSetting() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<FontPreferences>(() => readFontPreferences() ?? DEFAULT_FONT_PREFERENCES);

  const update = (kind: FontKind, patch: Partial<FontPreferences[FontKind]>) => {
    const next = { ...preferences, [kind]: { ...preferences[kind], ...patch } };
    setPreferences(next);
    saveFontPreferences(next);
  };

  return (
    <SettingsSection title={t("settings.typography")} description={t("settings.typography.desc")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.font.interface")} hint={t("settings.font.interfaceHint")}>
          <FontControl kind="interface" value={preferences.interface} onChange={(patch) => update("interface", patch)} />
        </SettingsRow>
        <SettingsRow label={t("settings.font.code")} hint={t("settings.font.codeHint")}>
          <FontControl kind="code" value={preferences.code} onChange={(patch) => update("code", patch)} />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

function FontControl({ kind, value, onChange }: {
  kind: FontKind;
  value: { preset: InterfaceFont | CodeFont; family: string };
  onChange: (patch: Partial<{ preset: InterfaceFont | CodeFont; family: string }>) => void;
}) {
  const { t } = useTranslation();
  const isCode = kind === "code";
  const presetKey = `settings.font.${kind}`;
  return (
    <div className="flex max-w-[26rem] flex-wrap items-center justify-end gap-2">
      <PopupSelect aria-label={t(presetKey)} value={value.preset} onChange={(event) => onChange({ preset: event.target.value as InterfaceFont | CodeFont })}>
        <option value="default">{t("settings.font.default")}</option>
        <option value="system">{t(isCode ? "settings.font.systemMono" : "settings.font.system")}</option>
        <option value="geist">{t(isCode ? "settings.font.geistMono" : "settings.font.geist")}</option>
        {!isCode && <option value="inter">Inter</option>}
        {isCode && <option value="jetbrains">JetBrains Mono</option>}
        <option value="custom">{t("settings.font.custom")}</option>
      </PopupSelect>
      {value.preset === "custom" && (
        <input aria-label={t("settings.font.localFamily")} value={value.family} maxLength={64}
          onChange={(event) => onChange({ family: event.target.value.normalize("NFC").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").slice(0, 64) })}
          placeholder={t("settings.font.localFamily")} className="h-8 w-36 rounded-md border border-gray-200 bg-transparent px-2 text-chat-ui text-gray-900 outline-none focus:border-accent-500 dark:border-white/10 dark:text-white" />
      )}
      <span className={`${isCode ? "font-mono" : "font-sans"} min-w-14 text-center text-chat-ui text-gray-600 dark:text-white/70`} aria-hidden="true">
        Aa 123
      </span>
    </div>
  );
}
