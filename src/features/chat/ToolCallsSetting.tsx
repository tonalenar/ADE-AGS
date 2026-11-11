import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";

import { loadChatPrefs, saveChatPrefs, useChatPrefs } from "./chatPrefs";
import { isToolCallVisibility, TOOL_CALL_VISIBILITIES } from "./timeline/toolCallVisibility";

/**
 * "Chamadas de ferramenta no chat" na página Chat (seção Atividade, como no T3 Code): quais comandos,
 * edições e buscas aparecem no fold "Trabalhou por …" de cada turno. Aprovações, perguntas e erros
 * sempre aparecem, em qualquer modo.
 */
export function ToolCallsSetting() {
  const { t } = useTranslation();
  const mode = useChatPrefs().toolCallVisibility;

  return (
    <SettingsSection title={t("chat.settings.activity")}>
      <SettingsGroup>
        <SettingsRow label={t("chat.settings.toolCalls.label")} hint={t("chat.settings.toolCalls.hint")}>
          <PopupSelect
            aria-label={t("chat.settings.toolCalls.label")}
            value={mode}
            onChange={(event) => {
              const next = event.target.value;
              if (isToolCallVisibility(next)) saveChatPrefs({ ...loadChatPrefs(), toolCallVisibility: next });
            }}
          >
            {TOOL_CALL_VISIBILITIES.map((option) => (
              <option key={option} value={option}>{t(`chat.settings.toolCalls.${option}`)}</option>
            ))}
          </PopupSelect>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
