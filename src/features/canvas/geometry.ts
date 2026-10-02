/**
 * La geometría del canvas, sin React: dónde va un nodo nuevo, dónde se dibuja la terminal
 * de un nodo y cuándo una terminal puede estar viva.
 *
 * ## Por qué la terminal solo vive al 100 %
 *
 * Escalar una terminal con CSS la rompe: xterm mide sus celdas sin la escala y el clic, la
 * selección y el cálculo de filas y columnas quedan corridos, y el texto se ve borroso.
 * Achicarle la fuente al alejarse cambiaría filas y columnas y le mandaría a la TUI un
 * resize por cada rueda del mouse. Así que la terminal se dibuja SIEMPRE a su tamaño real,
 * encima de su nodo, y solo cuando el canvas está al 100 %. Alejado, el nodo muestra una
 * vista previa de texto, que sí escala bien.
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

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
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

/** ¿Pueden las terminales estar vivas con este zoom? Solo al 100 % (ver arriba). */
export function isLive(zoom: number): boolean {
  return Math.abs(zoom - 1) < 0.005;
}

/** Dónde se dibuja la terminal de un nodo, en píxeles del área del canvas, al 100 %. */
export function terminalRect(box: Box, viewport: Viewport): Rect {
  return {
    left: Math.round(box.x + viewport.x + BORDER),
    top: Math.round(box.y + viewport.y + HEADER_H),
    width: Math.max(0, Math.round(box.w - 2 * BORDER)),
    height: Math.max(0, Math.round(box.h - HEADER_H - BORDER)),
  };
}

/** ¿Se ve algo de `rect` dentro de un área de `width`×`height`? */
export function intersects(rect: Rect, width: number, height: number): boolean {
  return rect.left < width && rect.top < height && rect.left + rect.width > 0 && rect.top + rect.height > 0;
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
