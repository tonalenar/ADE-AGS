/**
 * A câmera da tela de Design: qual ponto do mundo fica no canto de cima à esquerda da vista (`x`, `y`,
 * em px de mundo) e a escala. Tela = (mundo − câmera) · escala. Tudo aqui é puro: o componente só chama.
 */
export interface Camera { x: number; y: number; scale: number }
export interface Box { x: number; y: number; w: number; h: number }
export interface Limits { min: number; max: number }

/** O canvas vai de 1% a 800%. */
export const ZOOM_LIMITS: Limits = { min: 0.01, max: 8 };
/** Um passo do teclado/menu: ×1,25 para dentro, ×0,8 para fora. */
export const ZOOM_STEP = 1.25;
/** Os presets do menu de Zoom. */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;
/** O passo máximo de zoom por evento de roda: ln(1,25). */
export const MAX_WHEEL_LOG_STEP = Math.log(1.25);
/** Margem do enquadramento, teto de escala e a faixa reservada ao título de uma prancheta sozinha. */
export const FIT_MARGIN = 48;
export const FIT_MAX_SCALE = 2;
export const TITLE_BAND = 40;

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, scale: 1 };

export const clampScale = (scale: number, limits: Limits = ZOOM_LIMITS) =>
  Math.min(limits.max, Math.max(limits.min, Number.isFinite(scale) ? scale : 1));

export const toScreen = (cam: Camera, wx: number, wy: number) => ({ x: (wx - cam.x) * cam.scale, y: (wy - cam.y) * cam.scale });
export const toWorld = (cam: Camera, sx: number, sy: number) => ({ x: sx / cam.scale + cam.x, y: sy / cam.scale + cam.y });

/** Muda a escala mantendo parado o ponto do mundo que está sob (sx, sy) da tela. */
export function zoomAt(cam: Camera, nextScale: number, sx: number, sy: number, limits: Limits = ZOOM_LIMITS): Camera {
  const scale = clampScale(nextScale, limits);
  const anchor = toWorld(cam, sx, sy);
  return { scale, x: anchor.x - sx / scale, y: anchor.y - sy / scale };
}

/** Arrasta a vista `dx`, `dy` px de TELA (o conteúdo anda junto com o ponteiro). */
export const panBy = (cam: Camera, dx: number, dy: number): Camera => ({ ...cam, x: cam.x - dx / cam.scale, y: cam.y - dy / cam.scale });

export interface WheelLike { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean }

/** A roda em px: `deltaMode` 1 = linhas (16 px), 2 = páginas (a altura da vista). */
export function normalizeWheel(e: Pick<WheelLike, "deltaX" | "deltaY" | "deltaMode">, pageHeight: number) {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  return { dx: e.deltaX * k, dy: e.deltaY * k };
}

/**
 * Um evento de roda vira câmera nova: sem modificador é pan; com Ctrl/⌘ (o pinch do trackpad chega
 * como Ctrl) é zoom ancorado no cursor, `escala · e^(−dy·0,01)`, com o passo limitado a ±ln 1,25.
 */
export function wheelCamera(cam: Camera, e: WheelLike, sx: number, sy: number, pageHeight: number): Camera {
  const { dx, dy } = normalizeWheel(e, pageHeight);
  if (e.ctrlKey || e.metaKey) {
    const step = Math.max(-MAX_WHEEL_LOG_STEP, Math.min(MAX_WHEEL_LOG_STEP, -dy * 0.01));
    return zoomAt(cam, cam.scale * Math.exp(step), sx, sy);
  }
  return { ...cam, x: cam.x + dx / cam.scale, y: cam.y + dy / cam.scale };
}

/** Um passo de zoom (teclado ou menu) em torno do centro da vista. */
export function stepZoom(cam: Camera, direction: 1 | -1, width: number, height: number): Camera {
  return zoomAt(cam, cam.scale * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP), width / 2, height / 2);
}

/** A leitura do botão de Zoom: um inteiro em %, nunca menor que 1. */
export const zoomReadout = (scale: number) => Math.max(1, Math.round(scale * 100));
/** O zoom atual é um dos presets (para marcar o rádio)? Compara pela leitura. */
export const presetOf = (scale: number) => ZOOM_PRESETS.find((p) => zoomReadout(p) === zoomReadout(scale)) ?? null;
export const canZoomIn = (scale: number, limits: Limits = ZOOM_LIMITS) => scale < limits.max - 1e-9;
export const canZoomOut = (scale: number, limits: Limits = ZOOM_LIMITS) => scale > limits.min + 1e-9;

/** A caixa que cobre todas as caixas; `null` sem nenhuma. */
export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bottom - y };
}

/** A caixa de uma prancheta sozinha para enquadrar: inclui 40 px acima, onde fica o título. */
export const boardFitBox = (b: Box): Box => ({ x: b.x, y: b.y - TITLE_BAND, w: b.w, h: b.h + TITLE_BAND });

/**
 * Enquadra a caixa na vista `width`×`height`, descontando `top` px de barra: margem de 48 px, escala
 * `min(2, max(0,01, min((W−96)/w, (H−top−96)/h)))` (nunca passa de 200%) e o conteúdo centralizado.
 */
export function fitCamera(box: Box | null, width: number, height: number, top = 0): Camera {
  if (!box || width <= 0 || height <= 0) return DEFAULT_CAMERA;
  const avail = { w: width - FIT_MARGIN * 2, h: height - top - FIT_MARGIN * 2 };
  const raw = Math.min(avail.w / Math.max(1, box.w), avail.h / Math.max(1, box.h));
  const scale = Math.min(FIT_MAX_SCALE, Math.max(ZOOM_LIMITS.min, raw));
  return cameraCenteredOn(box.x + box.w / 2, box.y + box.h / 2, scale, width, height, top);
}

/** A câmera que põe o ponto (cx, cy) do mundo no centro da área útil (abaixo de `top`). */
export function cameraCenteredOn(cx: number, cy: number, scale: number, width: number, height: number, top = 0): Camera {
  return { scale, x: cx - width / 2 / scale, y: cy - (top + (height - top) / 2) / scale };
}

/** O retângulo do mundo que a vista mostra (abaixo da barra). */
export function visibleWorld(cam: Camera, width: number, height: number, top = 0): Box {
  return { x: cam.x, y: cam.y + top / cam.scale, w: width / cam.scale, h: Math.max(0, height - top) / cam.scale };
}

export const intersects = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Quais pranchetas montam o iframe: as que cruzam a vista alargada em `margin` (fração da vista) e,
 * do centro para fora, enquanto a área em TELA somada couber no orçamento (px²). Fora disso fica o
 * placeholder "Carregar prancheta". `pinned` são as que a pessoa mandou carregar: sempre vivas.
 */
export function liveBoards<T extends Box & { id: string }>(
  boards: T[], cam: Camera, width: number, height: number,
  opts: { top?: number; margin?: number; budget?: number; pinned?: ReadonlySet<string> } = {},
): Set<string> {
  const { top = 0, margin = 0.5, budget = 16e6, pinned } = opts;
  const view = visibleWorld(cam, width, height, top);
  const grown = { x: view.x - view.w * margin, y: view.y - view.h * margin, w: view.w * (1 + margin * 2), h: view.h * (1 + margin * 2) };
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  const near = boards
    .filter((b) => intersects(b, grown))
    .map((b) => ({ id: b.id, d: Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy), area: b.w * b.h * cam.scale * cam.scale }))
    .sort((a, b) => a.d - b.d);
  const live = new Set<string>(pinned ? [...pinned].filter((id) => boards.some((b) => b.id === id)) : []);
  let spent = 0;
  for (const b of near) {
    if (live.has(b.id)) continue;
    // A primeira sempre entra: uma prancheta enorme sozinha na vista não pode ficar descarregada.
    if (spent > 0 && spent + b.area > budget) continue;
    spent += b.area;
    live.add(b.id);
  }
  return live;
}

// ---------- Glide (animação da câmera) ----------

/** Uma cubic-bezier (como a do CSS) resolvida por bisseção em 12 iterações. */
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (t: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let s = t;
    for (let i = 0; i < 12; i += 1) {
      s = (lo + hi) / 2;
      if (at(p1x, p2x, s) < t) lo = s;
      else hi = s;
    }
    return at(p1y, p2y, (lo + hi) / 2);
  };
}

/** A curva "ease-out" da tela (.165, .84, .44, 1). */
export const glideEase = cubicBezier(0.165, 0.84, 0.44, 1);

const centerOf = (cam: Camera, width: number, height: number) => ({ x: cam.x + width / 2 / cam.scale, y: cam.y + height / 2 / cam.scale });

/** Quanto a vista "anda" em px de tela entre duas câmeras (deslocamento do centro + mudança de escala). */
export function screenDistance(a: Camera, b: Camera, width: number, height: number): number {
  const ca = centerOf(a, width, height);
  const cb = centerOf(b, width, height);
  const s = Math.min(a.scale, b.scale);
  return Math.hypot((cb.x - ca.x) * s, (cb.y - ca.y) * s) + Math.abs(Math.log(b.scale / a.scale)) * Math.max(width, height) / 2;
}

/** A duração do glide: `clamp(300, 18·√distância, 900)` ms; 0 se não há para onde ir ou com movimento reduzido. */
export function glideDuration(a: Camera, b: Camera, width: number, height: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  const d = screenDistance(a, b, width, height);
  if (d < 0.5) return 0;
  return Math.min(900, Math.max(300, 18 * Math.sqrt(d)));
}

/** A câmera no instante `t` (0–1) do glide: o centro anda em linha e a escala em log (espaço de tela). */
export function lerpCamera(a: Camera, b: Camera, t: number, width: number, height: number): Camera {
  const k = glideEase(t);
  const ca = centerOf(a, width, height);
  const cb = centerOf(b, width, height);
  const scale = Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * k);
  const cx = ca.x + (cb.x - ca.x) * k;
  const cy = ca.y + (cb.y - ca.y) * k;
  return { scale, x: cx - width / 2 / scale, y: cy - height / 2 / scale };
}

// ---------- Memória da câmera (sessionStorage) ----------

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** A chave da câmera de uma página: `design-view/<design>/<página>`. */
export const cameraKey = (designId: string, pageId: string) => `design-view/${designId}/${pageId}`;
/** A chave da última página aberta de um design. */
export const lastPageKey = (designId: string) => `design-view/${designId}`;

/** Lê a câmera lembrada; só vale se for da mesma página e a escala estiver dentro dos limites. Tolera lixo. */
export function readCamera(storage: StorageLike | null, designId: string, pageId: string): Camera | null {
  try {
    const raw = storage?.getItem(cameraKey(designId, pageId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v.page !== pageId) return null;
    const { x, y, scale } = v;
    if (typeof x !== "number" || typeof y !== "number" || typeof scale !== "number") return null;
    if (![x, y, scale].every(Number.isFinite)) return null;
    if (scale < ZOOM_LIMITS.min || scale > ZOOM_LIMITS.max) return null;
    return { x, y, scale };
  } catch {
    return null;
  }
}

export function writeCamera(storage: StorageLike | null, designId: string, pageId: string, cam: Camera): void {
  try {
    storage?.setItem(cameraKey(designId, pageId), JSON.stringify({ page: pageId, x: cam.x, y: cam.y, scale: cam.scale }));
    storage?.setItem(lastPageKey(designId), JSON.stringify({ page: pageId }));
  } catch {
    /* sem armazenamento: a câmera vale só enquanto a tela estiver aberta */
  }
}

export function readLastPage(storage: StorageLike | null, designId: string): string | null {
  try {
    const raw = storage?.getItem(lastPageKey(designId));
    const page = raw ? (JSON.parse(raw) as { page?: unknown }).page : null;
    return typeof page === "string" ? page : null;
  } catch {
    return null;
  }
}
