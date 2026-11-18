/** Só reatribui width/height do canvas quando o tamanho em pixels mudou. */
export function canvasBufferSize(cssWidth: number, cssHeight: number, dpr: number): { w: number; h: number } {
  const ratio = Math.min(dpr || 1, 2);
  return { w: Math.round(cssWidth * ratio), h: Math.round(cssHeight * ratio) };
}

export function needsCanvasResize(el: { width: number; height: number }, next: { w: number; h: number }): boolean {
  return el.width !== next.w || el.height !== next.h;
}
