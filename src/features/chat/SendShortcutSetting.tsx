import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";

import { loadChatPrefs, saveChatPrefs, useChatPrefs } from "./chatPrefs";
import { isSendShortcut, modifierLabel } from "./composerSendKey";

/**
 * "Enviar com" na página Chat (como no T3 Code, seção Composer): quando o Enter envia, quebra a linha
 * ou exige Cmd/Ctrl. A regra fica em `composerSendKey.ts`; o composer lê a mesma preferência.
 */
export function SendShortcutSetting() {
  const { t } = useTranslation();
  const sendShortcut = useChatPrefs().sendShortcut;
  const mod = modifierLabel(typeof navigator === "undefined" ? "" : navigator.userAgent);

  return (
    <SettingsSection title={t("chat.settings.sendSection")}>
      <SettingsGroup>
        <SettingsRow label={t("chat.settings.sendShortcut")} hint={t("chat.settings.sendShortcut.hint")}>
          <PopupSelect
            aria-label={t("chat.settings.sendShortcut")}
            value={sendShortcut}
            onChange={(event) => {
              const next = event.target.value;
              if (isSendShortcut(next)) saveChatPrefs({ ...loadChatPrefs(), sendShortcut: next });
            }}
          >
            <option value="enter">{t("chat.settings.send.enter")}</option>
            <option value="mod-enter-multiline">{t("chat.settings.send.modMultiline", { mod })}</option>
            <option value="mod-enter">{t("chat.settings.send.modAlways", { mod })}</option>
          </PopupSelect>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
