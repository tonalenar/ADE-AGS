/**
 * Tamaño del panel de chat: el usuario lo ajusta arrastrando el borde/esquina, queda guardado
 * por usuario (en este equipo) y se puede restaurar o maximizar. Todo lo de acá es puro salvo
 * `loadChatSize`/`saveChatSize`, que tocan `localStorage` y toleran que no esté.
 */
export interface ChatSize { width: number; height: number }
export interface ChatSizeState { size: ChatSize; maximized: boolean }

export const DEFAULT_CHAT_SIZE: ChatSize = { width: 416, height: 544 };
export const MIN_CHAT_SIZE: ChatSize = { width: 300, height: 320 };
/** Margen que el panel deja libre alrededor dentro del área (el botón de abajo, el borde). */
export const CHAT_MARGIN = { x: 24, y: 76 };
const KEY = "ags.chat.size.v1";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Limita un tamaño a [mínimo, máximo]. El máximo sale del área disponible, pero nunca baja del mínimo. */
export function clampSize(size: ChatSize, area: ChatSize): ChatSize {
  const maxW = Math.max(MIN_CHAT_SIZE.width, area.width - CHAT_MARGIN.x);
  const maxH = Math.max(MIN_CHAT_SIZE.height, area.height - CHAT_MARGIN.y);
  return {
    width: Math.round(Math.min(maxW, Math.max(MIN_CHAT_SIZE.width, size.width))),
    height: Math.round(Math.min(maxH, Math.max(MIN_CHAT_SIZE.height, size.height))),
  };
}

/** El tamaño al arrastrar: el panel está pegado abajo a la derecha, así que tirar hacia la
 *  izquierda/arriba lo agranda. `edge` dice qué lados se están moviendo. */
export function resizeBy(start: ChatSize, dx: number, dy: number, edge: { left: boolean; top: boolean }, area: ChatSize): ChatSize {
  return clampSize({
    width: edge.left ? start.width - dx : start.width,
    height: edge.top ? start.height - dy : start.height,
  }, area);
}

/** Lo guardado puede venir roto o de otra versión: se valida y, si no sirve, se ignora. */
export function parseChatSize(raw: string | null): ChatSizeState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { width?: unknown; height?: unknown; maximized?: unknown };
    if (!finite(v.width) || !finite(v.height)) return null;
    return { size: { width: v.width, height: v.height }, maximized: v.maximized === true };
  } catch {
    return null;
  }
}

export function loadChatSize(): ChatSizeState {
  try {
    return parseChatSize(localStorage.getItem(KEY)) ?? { size: DEFAULT_CHAT_SIZE, maximized: false };
  } catch {
    return { size: DEFAULT_CHAT_SIZE, maximized: false };
  }
}

export function saveChatSize(state: ChatSizeState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state.size, maximized: state.maximized }));
  } catch {
    // Sin almacenamiento (ventana privada, bloqueado): el tamaño vale solo para esta sesión.
  }
}

/** Con el tamaño por defecto o con el de ahora, ¿hace falta mostrar «restaurar»? */
export function isDefaultSize(size: ChatSize): boolean {
  return size.width === DEFAULT_CHAT_SIZE.width && size.height === DEFAULT_CHAT_SIZE.height;
}
