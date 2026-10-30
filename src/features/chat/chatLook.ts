import { create } from "zustand";

import { loadChatPrefs, saveChatPrefs, type ChatWidth } from "./chatPrefs";

/**
 * A largura da conversa (Configurações → Modo chat → Largura da conversa), ao vivo: a timeline e o
 * composer mudam na hora. Guardada com as outras preferências do chat.
 */
export const CHAT_WIDTH_CLASS: Record<ChatWidth, string> = {
  normal: "max-w-[736px]",
  wide: "max-w-[960px]",
  full: "max-w-none",
};

export const useChatLook = create<{ width: ChatWidth }>(() => ({ width: loadChatPrefs().width }));

export function setChatWidth(width: ChatWidth): void {
  useChatLook.setState({ width });
  saveChatPrefs({ ...loadChatPrefs(), width });
}

export const useChatWidthClass = () => CHAT_WIDTH_CLASS[useChatLook((s) => s.width)];
