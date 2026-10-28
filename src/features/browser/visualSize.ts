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

/** Uma região em px CSS da página. */
export interface PageBox { left: number; top: number; right: number; bottom: number }

/** O recorte pedido pelo piloto (em px CSS de uma página de `pageW`×`pageH`), com os selos 1..n sob cada marca. Sem região, a foto inteira. */
export function cropForJev(source: HTMLCanvasElement, pageW: number, pageH: number, region?: PageBox, marks?: PageBox[]): HTMLCanvasElement {
  if (!region || pageW <= 0 || pageH <= 0) return source;
  const fx = source.width / pageW;
  const fy = source.height / pageH;
  const sx = Math.max(0, Math.round(region.left * fx)), sy = Math.max(0, Math.round(region.top * fy));
  const sw = Math.min(source.width - sx, Math.round((region.right - region.left) * fx));
  const sh = Math.min(source.height - sy, Math.round((region.bottom - region.top) * fy));
  if (sw <= 4 || sh <= 4) return source;
  const crop = document.createElement("canvas");
  crop.width = sw;
  crop.height = sh;
  const ctx = crop.getContext("2d");
  ctx?.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  if (ctx && marks && marks.length > 1) {
    marks.forEach((m, i) => {
      const cx = ((m.left + m.right) / 2) * fx - sx;
      const w = (m.right - m.left) * fx;
      const r = Math.max(7, Math.min(16, w * 0.3));
      let cy = m.bottom * fy - sy + r + 2;
      if (cy + r > sh) cy = m.top * fy - sy - r - 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd400";
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.15);
      ctx.strokeStyle = "#000";
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.font = `800 ${Math.round(r * 1.25)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), cx, cy + r * 0.05);
    });
  }
  return crop;
}

/** O canvas no tamanho pedido (o que o Jev aceita, ver `visualSize`). */
export function resizeCanvas(source: HTMLCanvasElement, size: { width: number; height: number }): HTMLCanvasElement {
  if (size.width === source.width && size.height === source.height) return source;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, size.width, size.height);
  }
  return canvas;
}
