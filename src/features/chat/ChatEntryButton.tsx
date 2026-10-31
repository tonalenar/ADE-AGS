import { useTranslation } from "react-i18next";

import { useUiStore } from "@/app/uiStore";

import { ChatBubbleIcon } from "./chatIcons";

/** Da barra de abas para o modo chat. Só aparece com o modo chat ligado em Configurações → Avançado. */
export function ChatEntryButton() {
  const { t } = useTranslation();
  const enabled = useUiStore((s) => s.chatMode);
  const setShellMode = useUiStore((s) => s.setShellMode);
  if (!enabled) return null;
  return (
    <button type="button" onClick={() => setShellMode("chat")} data-tauri-drag-region="false"
      title={`${t("chat.mode.enter")} (Ctrl+Shift+L)`}
      className="cc-t flex items-center gap-1.5 h-7 px-2.5 my-auto shrink-0 rounded-lg text-[11.5px] font-medium
        text-gray-600 dark:text-gray-300 bg-black/5 dark:bg-white/[0.07]
        hover:text-gray-900 dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/[0.12]">
      <ChatBubbleIcon className="w-3.5 h-3.5" />
      {t("chat.mode.chat")}
    </button>
  );
}
