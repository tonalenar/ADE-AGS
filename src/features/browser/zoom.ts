/**
 * O zoom da página: quanto ela se ve de grande, sem mexer no tamanho do navegador.
 *
 * Uma página a 150% mede, para ela, dois terços da largura (as media queries veem 960 px num
 * navegador de 1440): é o zoom de um navegador de verdade. Por isso o iframe é desenhado numa área
 * maior/menor (`100% / zoom`) e depois escalado de volta (`transform: scale(zoom)`).
 */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

/** Os passos dos botões (e do Ctrl +/−): os mesmos do Chrome, mais um passo perto de 100%. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) * 100) / 100;
}

/** O próximo passo acima (`dir` = 1) ou abaixo (`dir` = -1) do zoom atual. Num valor entre dois passos, vai ao mais próximo na direção. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const z = clampZoom(current);
  if (dir === 1) return ZOOM_STEPS.find((step) => step > z + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < z - 0.001) ?? MIN_ZOOM;
}

/** "150%". */
export function zoomLabel(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}

/** O tamanho da área onde o iframe é desenhado para que, escalada por `zoom`, preencha 100% do espaço. */
export function stageSize(zoom: number): { width: string; height: string } {
  const z = clampZoom(zoom);
  return z === 1 ? { width: "100%", height: "100%" } : { width: `${100 / z}%`, height: `${100 / z}%` };
}
