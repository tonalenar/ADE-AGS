import { useTranslation } from "react-i18next";

import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";
import {
  CONTRAST_RANGE,
  GLASS_RANGE,
  saveDisplayPrefs,
  useDisplayPrefs,
  type DisplayPrefs,
  type EffortDisplay,
  type EnvironmentIdentification,
} from "@/features/settings/displayPreferences";

/**
 * A seção "Interface" da Aparência (como no T3 Code): o contraste das cores e bordas, a opacidade do
 * vidro dos menus, o esforço no composer, o selo do ambiente e o contexto do composer. Cada ajuste grava
 * no aparelho e aparece na hora: o contraste e o vidro pelas variáveis de `App.css`; os outros pelas telas.
 */
export function AppearanceInterfaceSetting() {
  const { t } = useTranslation();
  const prefs = useDisplayPrefs();
  const update = (patch: Partial<DisplayPrefs>) => saveDisplayPrefs({ ...prefs, ...patch });

  return (
    <SettingsSection title={t("settings.appearance.interface")}>
      <SettingsGroup>
        <SliderRow
          id="ade-appearance-contrast"
          label={t("settings.contrast.label")}
          hint={t("settings.contrast.hint")}
          min={CONTRAST_RANGE.min}
          max={CONTRAST_RANGE.max}
          value={prefs.contrast}
          format={(value) => `${value}%`}
          onChange={(contrast) => update({ contrast })}
        />
        <SliderRow
          id="ade-appearance-glass"
          label={t("settings.glass.label")}
          hint={t("settings.glass.hint")}
          min={GLASS_RANGE.min}
          max={GLASS_RANGE.max}
          value={prefs.glassOpacity}
          format={(value) => `${value}%`}
          onChange={(glassOpacity) => update({ glassOpacity })}
        />
        <SettingsRow label={t("settings.effort.label")} hint={t("settings.effort.hint")}>
          <ChatSegmented<EffortDisplay>
            label={t("settings.effort.label")}
            value={prefs.effortDisplay}
            onChange={(effortDisplay) => update({ effortDisplay })}
            options={[
              { value: "label", label: t("settings.effort.word") },
              { value: "bars", label: t("settings.effort.bars") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.envId.label")} hint={t("settings.envId.hint")}>
          <ChatSegmented<EnvironmentIdentification>
            label={t("settings.envId.label")}
            value={prefs.environmentIdentification}
            onChange={(environmentIdentification) => update({ environmentIdentification })}
            options={[
              { value: "auto", label: t("settings.envId.auto") },
              { value: "pill", label: t("settings.envId.always") },
              { value: "none", label: t("settings.envId.none") },
            ]}
          />
        </SettingsRow>
        <SettingsToggleRow
          label={t("settings.composerContext.label")}
          description={t("settings.composerContext.hint")}
          checked={prefs.composerContext}
          onChange={(composerContext) => update({ composerContext })}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** Um controle deslizante com o valor à direita, dentro de uma linha de ajuste. */
function SliderRow({ id, label, hint, min, max, value, format, onChange }: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[14px] font-medium text-gray-900 dark:text-white">{label}</span>
          <span className="text-[13px] text-gray-500 dark:text-white/50">{hint}</span>
        </label>
        <output htmlFor={id} className="shrink-0 font-mono text-chat-caption tabular-nums text-gray-600 dark:text-white/65">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent-600"
      />
    </div>
  );
}
