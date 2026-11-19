/** Diferença, em px, abaixo da qual o espaço da âncora não muda. */
const TOLERANCE = 2;
/** Ajustes por âncora antes de parar: o espaço converge em 1–2 passos; mais que isso é layout oscilando. */
const MAX_STEPS = 8;

/**
 * O próximo espaço reservado no fim da conversa para o pedido ficar perto do topo, ou `null` para manter.
 *
 * Mudar o espaço desloca o layout, e o espaço pedido depende do layout: em alguns arranjos o cálculo
 * alterna entre dois valores (A→B→A…). Como cada mudança roda de novo o efeito, isso virava laço de
 * renderização (React #185). `seen` guarda os valores já aplicados nesta âncora: um valor que volta
 * fica com o maior dos dois, e depois de `MAX_STEPS` ajustes o espaço para de mudar.
 */
export function settleAnchorSpace(current: number, required: number, seen: number[]): number | null {
  if (Math.abs(current - required) <= TOLERANCE) return null;
  if (seen.length >= MAX_STEPS) return null;
  if (seen.some((value) => Math.abs(value - required) <= TOLERANCE)) {
    const settled = Math.max(current, required);
    return Math.abs(settled - current) <= TOLERANCE ? null : settled;
  }
  return required;
}
