/**
 * Onde o Resumo cabe. Ele fica SOLTO à direita da conversa (como no Claude Code), sem coluna de painel:
 * a conversa continua com a largura mínima de sempre (`PANEL_W.conversationMin`) e, se não sobrar espaço
 * para os cartões, o Resumo some em vez de espremer o chat. Puro.
 */
import { PANEL_W } from "../store";

/** A largura dos cartões e o vão até a conversa. */
export const SUMMARY_W = 320;
export const SUMMARY_GAP = 16;

/** Cabem os cartões e ainda sobra a largura mínima da conversa? Sem medida (ainda), cabe. */
export function summaryFits(mainWidth: number | null): boolean {
  if (mainWidth === null || !Number.isFinite(mainWidth)) return true;
  return mainWidth - (SUMMARY_W + SUMMARY_GAP) >= PANEL_W.conversationMin;
}

/** O espaço que a conversa cede à direita para o Resumo (0 com outra superfície, ou sem lugar). */
export function chatInset(panel: string | null, mainWidth: number | null): number {
  return panel === "summary" && summaryFits(mainWidth) ? SUMMARY_W + SUMMARY_GAP : 0;
}
