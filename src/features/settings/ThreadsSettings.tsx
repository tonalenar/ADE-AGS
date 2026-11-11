import { useTranslation } from "react-i18next";

import { AUTO_SETTLE_CHOICES, type AutoSettleChoice } from "@/features/chat/sidebar/autoSettle";
import { saveAutoSettleChoice, useAutoSettleChoice } from "@/features/chat/sidebar/autoSettlePrefs";
import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";

/**
 * Configurações → Threads (como o T3 Code). Hoje tem "Concluir sozinho": a conversa parada há N dias sai da
 * lista ativa, sem ser apagada. É uma preferência deste aparelho.
 */
export function ThreadsSettings() {
  const { t } = useTranslation();
  const choice = useAutoSettleChoice();
  return (
    <SettingsSection title={t("settings.threads.autoSettle.title")} description={t("settings.threads.autoSettle.desc")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.threads.autoSettle.label")} hint={t(`settings.threads.autoSettle.hint.${choice}`)}>
          <ChatSegmented<AutoSettleChoice>
            label={t("settings.threads.autoSettle.label")}
            value={choice}
            onChange={(next) => saveAutoSettleChoice(next)}
            options={AUTO_SETTLE_CHOICES.map((c) => ({ value: c, label: t(`settings.threads.autoSettle.option.${c}`) }))}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
