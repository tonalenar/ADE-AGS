/**
 * O que a página Uso e preços precisa sem React: ler um preço digitado. O backend valida o resto (o modelo e a
 * faixa do preço) e devolve a mensagem em texto.
 */

/**
 * Um preço digitado em USD por milhão de tokens. Aceita vírgula ou ponto como separador (o pt-BR usa vírgula).
 * Vazio, negativo ou com letra vira `null`: a tela pede de novo em vez de gravar lixo.
 */
export function parsePriceInput(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}
