import { useTranslation } from "react-i18next";

import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import {
  saveDiffPrefs,
  useDiffPrefs,
  type DiffColorScheme,
  type DiffLayout,
} from "@/features/settings/diffPreferences";

/**
 * A página "Diffs" das Configurações (como no T3 Code): o layout (empilhado ou lado a lado), as cores
 * das adições e remoções e o estado inicial dos trechos. O botão na barra do diff muda o mesmo layout.
 */
export function DiffsSetting() {
  const { t } = useTranslation();
  const prefs = useDiffPrefs();

  return (
    <SettingsSection title={t("settings.diffs")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.diffs.layout.label")} hint={t("settings.diffs.layout.hint")}>
          <ChatSegmented<DiffLayout>
            label={t("settings.diffs.layout.label")}
            value={prefs.layout}
            onChange={(layout) => saveDiffPrefs({ ...prefs, layout })}
            options={[
              { value: "stacked", label: t("settings.diffs.layout.stacked") },
              { value: "split", label: t("settings.diffs.layout.split") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.diffs.colors.label")} hint={t("settings.diffs.colors.hint")}>
          <ChatSegmented<DiffColorScheme>
            label={t("settings.diffs.colors.label")}
            value={prefs.colors}
            onChange={(colors) => saveDiffPrefs({ ...prefs, colors })}
            options={[
              { value: "red-green", label: t("settings.diffs.colors.redGreen") },
              { value: "blue-orange", label: t("settings.diffs.colors.blueOrange") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.diffs.state.label")} hint={t("settings.diffs.state.hint")}>
          <ChatSegmented<"collapsed" | "expanded">
            label={t("settings.diffs.state.label")}
            value={prefs.filesCollapsed ? "collapsed" : "expanded"}
            onChange={(state) => saveDiffPrefs({ ...prefs, filesCollapsed: state === "collapsed" })}
            options={[
              { value: "collapsed", label: t("settings.diffs.state.collapsed") },
              { value: "expanded", label: t("settings.diffs.state.expanded") },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
