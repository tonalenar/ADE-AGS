/**
 * Mensagem grande recolhida, como no Claude Code: o balão fecha em ~9 linhas da prosa do chat
 * (24 px cada) e o fim some num degradê, com "Mostrar mais" dentro do balão.
 */
export const COLLAPSED_LINES = 9;
export const LINE_PX = 24;
/** A altura do balão recolhido. */
export const COLLAPSED_PX = COLLAPSED_LINES * LINE_PX;

/** O texto passa do limite? Com folga de uma linha, para não recolher por 1 ou 2 linhas a mais. Pura. */
export function overflowsLimit(contentPx: number, limitPx: number = COLLAPSED_PX): boolean {
  return contentPx > limitPx + LINE_PX;
}
