/*
 * Medidas do Claude Code adotadas aqui e em `App.css` (tokens `--text-chat-*`), lidas no print do app
 * (2000 px de largura = 1 pt ≈ 1,365 px; o ADE no mesmo print serviu de régua):
 *  - corpo das mensagens: 15 px, entrelinha 21,5 px (a pauta do print mede 29 px = 21,25 pt; o ADE antigo,
 *    16/24, media 32,4 px). Entre parágrafos: ~10 px (43 px de passo contra 29 de linha).
 *  - as falas do agente são TEXTO CORRIDO no fundo da página, sem balão; a pessoa continua em balão
 *    cinza (o print não mostra mensagem de pessoa: é suposição).
 *  - cartão do composer: raio 20 px, fundo sólido, borda de 1 px e sombra leve; texto a 20 px da borda
 *    (o do print: 28 px = 20 pt); a lista rola por baixo dele, com degradê de 32 px no alto.
 *  - distância do cartão ao fundo ~40 pt: `pb-4` da coluna + a linha pequena de 13 px embaixo (`ContextStrip`).
 * São aproximações de uma captura; peça um print novo para afinar.
 */
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
