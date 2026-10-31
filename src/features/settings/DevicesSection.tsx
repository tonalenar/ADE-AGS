import { useTranslation } from "react-i18next";

import { HIBERNATE_OPTIONS, useSimulatorPrefs } from "@/features/simulator/prefs";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "./SettingsSection";

/**
 * Dispositivos (prancheta 5): o simulador iOS e o Android que abrem no canvas e no painel direito do
 * chat. As escolhas são as mesmas da barra do aparelho no canvas (`useSimulatorPrefs`).
 */
export function DevicesSection() {
  const { t } = useTranslation();
  const light = useSimulatorPrefs((s) => s.light);
  const single = useSimulatorPrefs((s) => s.single);
  const hibernateMin = useSimulatorPrefs((s) => s.hibernateMin);
  const set = useSimulatorPrefs((s) => s.set);
  return (
    <>
      <SettingsSection title={t("settings.devices.ios")}>
        <SettingsGroup>
          <SettingsToggleRow label={t("simulator.lightShort")} description={t("simulator.light")} checked={light} onChange={(next) => set({ light: next })} />
          <SettingsToggleRow label={t("simulator.single")} description={t("settings.devices.singleHint")} checked={single} onChange={(next) => set({ single: next })} />
          <SettingsRow label={t("simulator.hibernate")} hint={t("settings.devices.hibernateHint")}>
            <PopupSelect value={String(hibernateMin)} onChange={(e) => set({ hibernateMin: Number(e.target.value) })}>
              {HIBERNATE_OPTIONS.map((m) => (
                <option key={m} value={m}>{m === 0 ? t("simulator.hibernateNever") : t("simulator.hibernateMin", { count: m })}</option>
              ))}
            </PopupSelect>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title={t("settings.devices.android")}>
        <SettingsGroup>
          <SettingsRow label={t("settings.devices.adb")} hint={t("settings.devices.adbHint")}>
            <code className="text-[12px] text-gray-500 dark:text-white/50">ags device …</code>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </>
  );
}
