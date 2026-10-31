import { useTabsStore } from "@/features/tabs/store";

import { threadIdOf } from "../structured/model";
import { mentionsFor, withAttachmentBlock, type Attachment } from "./attachModel";

/**
 * O texto (e as imagens em linha) de uma mensagem com anexos para a conversa `ref`. O caminho de cada
 * anexo SEMPRE vai no texto, para qualquer motor: é o fallback que nunca descarta um anexo em silêncio.
 * - conversa por protocolo: o bloco `[Anexos]` no fim do texto; as imagens vão também como blocos em linha
 *   para o motor que as aceita (o backend decide, ver `conversa/attach.rs`);
 * - aba com TUI: `@caminho` no fim do texto, como o terminal já faz ao soltar arquivos nele.
 * Sem anexos, o texto passa intacto. Pura em tudo menos em olhar a aba.
 */
export function messageFor(ref: string, text: string, attachments: Attachment[]): { text: string; images: string[] } {
  if (threadIdOf(ref)) return threadMessage(text, attachments);
  const agentId = useTabsStore.getState().tabs.find((t) => t.id === ref)?.agentId;
  return { text: tuiMessage(agentId, text, attachments), images: [] };
}

/** Para uma conversa por protocolo (que pode ainda nem existir, na tela "Nova conversa"). Pura. */
export function threadMessage(text: string, attachments: Attachment[]): { text: string; images: string[] } {
  if (attachments.length === 0) return { text, images: [] };
  return { text: withAttachmentBlock(text, attachments), images: attachments.filter((a) => a.kind === "image").map((a) => a.path) };
}

/** Para uma aba com TUI: `@caminho` no fim do texto (o resumo do time continua abrindo a mensagem). Pura. */
export function tuiMessage(agentId: string | undefined, text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const mentions = mentionsFor(agentId, attachments).trimEnd();
  return text.trim() ? `${text.trimEnd()} ${mentions}` : mentions;
}
