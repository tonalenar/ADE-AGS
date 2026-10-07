/**
 * La geometría del canvas, sin React: dónde va un nodo nuevo, dónde se dibuja la terminal
 * de un nodo y cuándo una terminal puede estar viva.
 *
 * ## Cómo vive la terminal al alejar el zoom
 *
 * Achicarle la fuente al alejarse cambiaría filas y columnas y le mandaría a la TUI un
 * resize por cada rueda del mouse. Así que la terminal se dibuja SIEMPRE a su tamaño real
 * (mismas filas y columnas) encima de su nodo, y al alejar el zoom se la ESCALA con CSS
 * (`rect.scale`) hasta el tamaño del nodo. Así se puede seguir escribiendo con el zoom
 * reducido. Costo conocido: xterm mide el mouse sin la escala, así que seleccionar texto
 * con el mouse queda corrido por debajo del 100 % (el teclado y la rueda no se afectan).
 * Muy alejado (`LIVE_MIN_ZOOM`) el texto ya no se lee y el nodo muestra una vista previa.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const DEFAULT_VIEWPORT: Viewport = { x: 40, y: 40, zoom: 1 };

/** Una vista válida: x, y y zoom finitos y zoom > 0. Un NaN guardado vuelve como `null` y deja el canvas muerto. */
export function isValidViewport(v: unknown): v is Viewport {
  const o = v as Partial<Viewport> | null | undefined;
  return !!o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.zoom) && (o.zoom as number) > 0;
}

/** `v` si es válida; si no, `fallback` (la vista inicial por defecto). */
export function safeViewport(v: unknown, fallback: Viewport = DEFAULT_VIEWPORT): Viewport {
  return isValidViewport(v) ? v : fallback;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Escala CSS con que se dibuja (zoom del canvas). Ausente = 1. `left/top` ya van escalados; `width/height` son el tamaño REAL. */
  scale?: number;
}

/** Alto de la cabecera de un nodo (nombre, agente, botones). La terminal va debajo. */
export const HEADER_H = 34;
/** El borde del nodo, que la terminal no tapa. */
export const BORDER = 1;
export const NODE_DEFAULT = { w: 760, h: 460 };
export const NODE_MIN = { w: 380, h: 220 };
/** Separación entre nodos colocados solos. */
export const GAP = 56;
/** Columnas de la grilla en la que se acomodan los nodos nuevos. */
const COLUMNS = 2;

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 1;

/** Por debajo de este zoom el texto de la terminal ya no se lee: se muestra la vista previa. */
export const LIVE_MIN_ZOOM = 0.4;

/** ¿Pueden las terminales estar vivas (escritas y leídas) con este zoom? (ver arriba). */
export function isLive(zoom: number): boolean {
  return zoom >= LIVE_MIN_ZOOM;
}

/**
 * Dónde se dibuja la terminal de un nodo, en píxeles del área del canvas. El tamaño es el
 * real (no cambia con el zoom); la posición sí, y `scale` la achica hasta el nodo.
 */
export function terminalRect(box: Box, viewport: Viewport): Rect {
  const z = viewport.zoom > 0 ? viewport.zoom : 1;
  const rect: Rect = {
    left: Math.round(box.x * z + viewport.x + BORDER * z),
    top: Math.round(box.y * z + viewport.y + HEADER_H * z),
    width: Math.max(0, Math.round(box.w - 2 * BORDER)),
    height: Math.max(0, Math.round(box.h - HEADER_H - BORDER)),
  };
  // Al 100 % (o casi) no se escala: el camino de siempre, sin transformaciones.
  return Math.abs(z - 1) < 0.005 ? rect : { ...rect, scale: z };
}

/** ¿Se ve algo de `rect` (con su escala) dentro de un área de `width`×`height`? */
export function intersects(rect: Rect, width: number, height: number): boolean {
  const s = rect.scale ?? 1;
  return rect.left < width && rect.top < height && rect.left + rect.width * s > 0 && rect.top + rect.height * s > 0;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + GAP / 2 && b.x < a.x + a.w + GAP / 2 && a.y < b.y + b.h + GAP / 2 && b.y < a.y + a.h + GAP / 2;
}

/**
 * Un lugar libre para un nodo nuevo: la primera celda de una grilla de dos columnas que
 * no pisa a ninguno de los que ya están. Los que el usuario movió a mano se respetan —
 * el nuevo se acomoda alrededor, no encima.
 */
export function nextFreeBox(existing: Box[], size = NODE_DEFAULT): Box {
  for (let i = 0; i < 1000; i++) {
    const col = i % COLUMNS;
    const row = Math.floor(i / COLUMNS);
    const candidate = { x: col * (size.w + GAP), y: row * (size.h + GAP), w: size.w, h: size.h };
    if (!existing.some((b) => overlaps(candidate, b))) return candidate;
  }
  // Mil celdas ocupadas no pasa en la práctica; si pasa, debajo de todo.
  const bottom = Math.max(0, ...existing.map((b) => b.y + b.h));
  return { x: 0, y: bottom + GAP, w: size.w, h: size.h };
}

/** Un lado del nodo, que es también el id de su punto de conexión. */
export type Side = "l" | "r" | "t" | "b";

/**
 * Por qué lados sale y entra la línea entre dos nodos: los que se miran. Si están más uno
 * encima del otro que uno al lado del otro, arriba y abajo; si no, los costados. Con un
 * solo par de costados, un equipo apilado como organigrama dibujaba curvas que cruzaban
 * los nodos.
 */
export function facingSides(a: Box, b: Box): [Side, Side] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? ["b", "t"] : ["t", "b"];
  return dx >= 0 ? ["r", "l"] : ["l", "r"];
}

/**
 * La vista que centra un nodo al 100 %. Si no entra en el área, se alinea arriba a la
 * izquierda con un margen: así se ve el comienzo de la terminal en vez de su centro.
 */
export function focusViewport(box: Box, width: number, height: number): Viewport {
  const margin = 24;
  const x = box.w + 2 * margin <= width ? width / 2 - (box.x + box.w / 2) : margin - box.x;
  const y = box.h + 2 * margin <= height ? height / 2 - (box.y + box.h / 2) : margin - box.y;
  return { x: Math.round(x), y: Math.round(y), zoom: 1 };
}
