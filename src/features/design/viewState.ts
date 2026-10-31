import { intersects, visibleWorld, type Box, type Camera } from "./camera";

/**
 * O que a pessoa está vendo na tela de Design, publicado ao backend (`design_view_set`) para o agente
 * ler com `ags design view` antes de mexer "nisto aqui". Puro; o debounce fica em `createDebouncer`.
 */
export interface ViewArtboard { id: string; title: string }
export interface ViewSelection { kind: "text" | "image" | "shape" | "line" | "other"; label: string }
export interface DesignViewState {
  mode: "canvas" | "focused";
  pageId: string;
  pageName: string;
  visibleArtboards: ViewArtboard[];
  selectedArtboards: ViewArtboard[];
  selected: string[];
  selection: ViewSelection[];
  zoom: number;
  updatedAt: number;
}

export const VIEW_LIMITS = { visible: 20, selected: 20, selection: 5, label: 60, bytes: 3072 } as const;
export const VIEW_DEBOUNCE_MS = 400;

/** Um elemento escolhido dentro de uma prancheta (o clique no modo Seleção). */
export interface PickedElement { artboardId: string; selector: string; kind: ViewSelection["kind"]; label: string }

export function buildViewState(input: {
  mode: "canvas" | "focused";
  page: { id: string; name: string };
  boards: Array<Box & { id: string; title: string }>;
  camera: Camera;
  viewport: { width: number; height: number; top: number };
  focusedId: string | null;
  selectedIds: string[];
  picked: PickedElement[];
  now: number;
}): DesignViewState {
  const { boards, camera, viewport } = input;
  const view = visibleWorld(camera, viewport.width, viewport.height, viewport.top);
  const visible = input.mode === "focused"
    ? boards.filter((b) => b.id === input.focusedId)
    : boards.filter((b) => intersects(b, view));
  const pick = (b: { id: string; title: string }) => ({ id: b.id, title: b.title });
  return {
    mode: input.mode,
    pageId: input.page.id,
    pageName: input.page.name,
    visibleArtboards: visible.slice(0, VIEW_LIMITS.visible).map(pick),
    selectedArtboards: boards.filter((b) => input.selectedIds.includes(b.id)).slice(0, VIEW_LIMITS.selected).map(pick),
    selected: input.picked.slice(0, VIEW_LIMITS.selected).map((p) => `${p.artboardId}#${p.selector}`),
    selection: input.picked.slice(0, VIEW_LIMITS.selection).map((p) => ({ kind: p.kind, label: p.label.slice(0, VIEW_LIMITS.label) })),
    zoom: Math.round(input.mode === "focused" ? 100 : camera.scale * 100) / 100,
    updatedAt: input.now,
  };
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Cabe em 3072 bytes: tenta inteiro; senão a versão enxuta (sem títulos nem seleção detalhada). */
export function fitViewState(state: DesignViewState, max: number = VIEW_LIMITS.bytes): DesignViewState {
  if (bytes(state) <= max) return state;
  const lean: DesignViewState = {
    ...state,
    visibleArtboards: state.visibleArtboards.map((b) => ({ id: b.id, title: "" })),
    selectedArtboards: state.selectedArtboards.map((b) => ({ id: b.id, title: "" })),
    selection: [],
  };
  if (bytes(lean) <= max) return lean;
  return { ...lean, visibleArtboards: lean.visibleArtboards.slice(0, 5), selected: lean.selected.slice(0, 5), selectedArtboards: lean.selectedArtboards.slice(0, 5) };
}

/** Só republica quando algo além do relógio mudou. */
export const sameViewState = (a: DesignViewState | null, b: DesignViewState) =>
  !!a && JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });

/** Chama `fn` com o último valor `ms` depois da última chamada. `cancel` descarta o pendente. */
export function createDebouncer<T>(ms: number, fn: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push(value: T) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(value); }, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * As pranchetas que o agente acabou de mudar: a versão subiu desde a última leitura. Na primeira
 * leitura (`prev` nulo) nada conta, para não piscar tudo ao abrir. Pranchetas novas contam.
 */
export function bumpedBoards(prev: Record<string, number> | null, boards: Array<{ id: string; version: number }>): string[] {
  if (!prev) return [];
  return boards.filter((b) => prev[b.id] === undefined || b.version > prev[b.id]).map((b) => b.id);
}

export const versionsOf = (boards: Array<{ id: string; version: number }>) => Object.fromEntries(boards.map((b) => [b.id, b.version]));
