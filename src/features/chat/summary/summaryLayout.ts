/**
 * Onde o Resumo cabe. Ele fica SOLTO à direita da conversa (como no Claude Code), sem coluna de painel:
 * a conversa continua com a largura mínima de sempre (`PANEL_W.conversationMin`) e, se não sobrar espaço
 * para os cartões, o Resumo passa a flutuar POR CIMA da conversa em vez de espremê-la (ou sumir). Puro.
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

export type SummaryPlacement = "none" | "beside" | "overlay";

/**
 * Onde o Resumo fica: ao lado da conversa quando cabe; POR CIMA dela quando a janela é estreita (antes sumia, e o
 * botão do cabeçalho seguia marcado sem painel nenhum, e desmarcar e marcar de novo não trazia nada); nada com outra
 * superfície à vista. Puro.
 */
export function summaryPlacement(panel: string | null, mainWidth: number | null): SummaryPlacement {
  if (panel !== "summary") return "none";
  return summaryFits(mainWidth) ? "beside" : "overlay";
}
