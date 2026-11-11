import { chatShellOn, useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";

/**
 * A conversa de uma aba está à vista: a casca do chat aberta e a aba dela ativa. Quando um agente mostra algo ao lado
 * da conversa (um aparelho, uma página HTML), só mostra se a pessoa está olhando para ela. Efeito de leitura.
 */
export function conversationOnScreen(tabId: string): boolean {
  return chatShellOn(useUiStore.getState()) && useTabsStore.getState().activeTabId === tabId;
}
