// O `i18next` puro, como em `terminals.ts`: o wrapper `@/i18n` grava o idioma no banco ao carregar, e isso não é deste módulo.
import i18n from "i18next";
import type { BotToastInput } from "@/shared/brand/botToastStore";

/**
 * Abre a conversa do aviso pela navegação que já existe (`openConversation`). Carregada no clique, e não no import: o
 * Vigia não puxa o chat para dentro do próprio módulo de carga.
 */
export async function abrirConversaDoVigia(tabId: string): Promise<void> {
  const { openConversation } = await import("@/features/chat/chatActions");
  openConversation(tabId);
}

/**
 * Um aviso do Vigia no globo, com "Abrir conversa": pula à conversa de que o aviso fala. É o integrante que travou (laço,
 * repetição, contexto quase cheio) ou o líder, quando é ele que pede o OK para fechar ou a decisão da pessoa. Antes, o
 * aviso só dizia o problema e a pessoa precisava achar a aba. Usa a chave `chat.inbox.open` (já traduzida nos três idiomas).
 */
export function vigiaToast(title: string, text: string, tabId: string, ms = 12_000): BotToastInput {
  return {
    title,
    text,
    tone: "warning",
    ms,
    actionLabel: i18n.t("chat.inbox.open"),
    onAction: () => {
      abrirConversaDoVigia(tabId).catch((error: unknown) => console.error("[Vigia] não foi possível abrir a conversa", error));
    },
  };
}
