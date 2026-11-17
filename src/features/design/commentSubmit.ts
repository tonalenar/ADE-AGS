/** Só manda o comentário ao agente se a gravação devolveu o comentário (não null/erro). */
export function shouldSendCommentToAgent(saved: unknown, send: boolean): boolean {
  return send && saved != null;
}
