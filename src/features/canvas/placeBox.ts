/**
 * Criar um elemento no canvas desenhando o retângulo (como no Maestri): escolhe-se a ferramenta, arrasta-se
 * no canvas e o elemento nasce com aquele tamanho. Um clique sem arrastar usa o tamanho padrão (o do tipo ou
 * o que a pessoa mandou lembrar). Lógica pura, sem React.
 */
import { FOLDER_MIN, FOLDER_SIZE, NOTE_MIN, NOTE_SIZE, PHONE_MIN, PHONE_SIZE, PORTAL_MIN, PORTAL_SIZE, TEXT_DEFAULT } from "./board";
import { NODE_DEFAULT, NODE_MIN, type Box } from "./geometry";

export type PlaceKind = "terminal" | "note" | "portal" | "device" | "text" | "folder";

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Quanto o ponteiro precisa andar (em px da tela) para contar como "desenhar" e não como clique. */
export const DRAG_THRESHOLD = 8;

/** Menor tamanho que cada tipo aceita: o mesmo que o redimensionar já respeita. */
export const KIND_MIN: Record<PlaceKind, Size> = {
  terminal: NODE_MIN,
  note: NOTE_MIN,
  portal: PORTAL_MIN,
  device: PHONE_MIN,
  text: { w: 80, h: 36 },
  folder: FOLDER_MIN,
};

/** Tamanho de fábrica de cada tipo (o que um clique solto cria). */
export const KIND_DEFAULT: Record<PlaceKind, Size> = {
  terminal: NODE_DEFAULT,
  note: NOTE_SIZE,
  portal: PORTAL_SIZE,
  device: PHONE_SIZE,
  text: { w: TEXT_DEFAULT.w, h: Math.round(TEXT_DEFAULT.size * 2.6) },
  folder: FOLDER_SIZE,
};

/** Maior lado aceito: um arrasto enorme por engano não cria um elemento do tamanho do mundo. */
export const MAX_SIDE = 4000;

/** Encaixa o tamanho entre o mínimo do tipo e o máximo geral. Pura. */
export function clampSize(kind: PlaceKind, size: Size): Size {
  const min = KIND_MIN[kind];
  const fit = (value: number, floor: number) => Math.min(MAX_SIDE, Math.max(floor, Math.round(Number.isFinite(value) ? value : floor)));
  return { w: fit(size.w, min.w), h: fit(size.h, min.h) };
}

/** O tamanho padrão de um tipo: o lembrado, se for válido, ou o de fábrica. Pura. */
export function defaultSize(kind: PlaceKind, remembered: Partial<Record<PlaceKind, Size>> = {}): Size {
  const own = remembered[kind];
  return own && Number.isFinite(own.w) && Number.isFinite(own.h) ? clampSize(kind, own) : KIND_DEFAULT[kind];
}

/** O ponteiro andou o bastante para ser um desenho? `zoom` converte px da tela em px do canvas. Pura. */
export function isDrag(a: Point, b: Point, zoom: number): boolean {
  const z = zoom > 0 ? zoom : 1;
  return Math.hypot(b.x - a.x, b.y - a.y) * z >= DRAG_THRESHOLD;
}

/**
 * O retângulo de um arrasto (pontos em coordenadas do canvas): vale qualquer sentido do arrasto, o tamanho é
 * ajustado ao mínimo do tipo e o canto de partida fica onde estava (se o mínimo alarga, alarga para o lado
 * em que se arrastou). Um clique solto vira o tamanho padrão CENTRADO no ponto. Pura.
 */
export function boxFromDrag(kind: PlaceKind, from: Point, to: Point, zoom: number, remembered: Partial<Record<PlaceKind, Size>> = {}): Box {
  if (!isDrag(from, to, zoom)) {
    const size = defaultSize(kind, remembered);
    return { x: Math.round(from.x - size.w / 2), y: Math.round(from.y - size.h / 2), w: size.w, h: size.h };
  }
  const raw = { w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
  const size = clampSize(kind, raw);
  const x = to.x >= from.x ? from.x : from.x - size.w;
  const y = to.y >= from.y ? from.y : from.y - size.h;
  return { x: Math.round(x), y: Math.round(y), w: size.w, h: size.h };
}

/** O texto "largura × altura" do rótulo ao lado do retângulo. Pura. */
export function sizeLabel(size: Size): string {
  return `${Math.round(size.w)} × ${Math.round(size.h)}`;
}

export const SIZES_KEY = "ade-canvas-place-sizes";

const KINDS = Object.keys(KIND_DEFAULT) as PlaceKind[];

/** Lê os tamanhos lembrados: só tipos conhecidos com números finitos; o resto é lixo e se ignora. Pura. */
export function parseSizes(raw: string | null): Partial<Record<PlaceKind, Size>> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<PlaceKind, Size>> = {};
    for (const kind of KINDS) {
      const value = (parsed as Record<string, Partial<Size> | undefined>)[kind];
      if (value && Number.isFinite(value.w) && Number.isFinite(value.h)) out[kind] = clampSize(kind, value as Size);
    }
    return out;
  } catch {
    return {};
  }
}

export function loadSizes(): Partial<Record<PlaceKind, Size>> {
  try {
    return parseSizes(localStorage.getItem(SIZES_KEY));
  } catch {
    return {};
  }
}

/** Lembra (ou, com `size` nulo, esquece) o tamanho de um tipo. Devolve o conjunto novo. */
export function rememberSize(current: Partial<Record<PlaceKind, Size>>, kind: PlaceKind, size: Size | null): Partial<Record<PlaceKind, Size>> {
  const next = { ...current };
  if (size) next[kind] = clampSize(kind, size);
  else delete next[kind];
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(next));
  } catch {
    /* não poder lembrar não impede de usar */
  }
  return next;
}
