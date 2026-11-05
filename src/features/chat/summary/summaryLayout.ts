/**
 * O Resumo é uma aba do painel direito, numa coluna própria ao lado da conversa (como o simulador, o navegador e o
 * terminal). Antes ele flutuava dentro da conversa: com a janela estreita (~1000 px) passava POR CIMA do texto, e com
 * outra superfície aberta sumia. Como coluna, empurra a conversa e nunca a cobre; com outra superfície, é a outra aba
 * do mesmo painel, a um clique na fileira de ícones.
 */

/** A largura da coluna do Resumo: a dos cartões (320 px) com a margem do painel. Fixa (não é a largura arrastável
 * das outras superfícies, que costuma ser larga demais para os cartões). */
export const SUMMARY_W = 360;

/** A largura do painel direito para a aba aberta: a do Resumo é fixa; as outras usam a que a pessoa arrastou. Pura. */
export function panelColumnWidth(panel: string | null, dragged: number): number {
  return panel === "summary" ? SUMMARY_W : dragged;
}
