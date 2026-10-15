/**
 * O tamanho com que a foto vai ao Jev. Medido com o Jev real (1.14): ele só aceita fotos com ÁREA entre cerca de
 * 150 mil e 1,4 milhão de pixels, em qualquer proporção razoável — 500×300 passa, 485×258 e 512×200 não;
 * 1500×900 passa, 1600×960 não. Fora disso responde HTTP 400 "Invalid image dimensions". A janela de um navegador do
 * canvas é pequena (485×258 num nó de 640×340) ou, numa tela grande, enorme: a foto é redimensionada para o meio da
 * faixa. As frações da caixa que o Jev devolve valem em qualquer tamanho, então nada se perde.
 */

/** A faixa de áreas que o app aceita mandar (com folga dentro da medida). */
export const MIN_AREA = 250_000;
export const MAX_AREA = 1_200_000;
const SMALL_TARGET = 500_000;
const BIG_TARGET = 800_000;

/** O tamanho final da foto: o mesmo se já cabe na faixa; senão, na mesma proporção, no meio dela. Pura. */
export function visualSize(width: number, height: number): { width: number; height: number } {
  const area = width * height;
  if (!(area > 0)) return { width, height };
  if (area >= MIN_AREA && area <= MAX_AREA) return { width, height };
  const scale = Math.sqrt((area < MIN_AREA ? SMALL_TARGET : BIG_TARGET) / area);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
