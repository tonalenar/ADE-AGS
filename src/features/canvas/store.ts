import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { useTabsStore } from "@/features/tabs/store";
import { comparablePath } from "@/features/tabs/viewTabs";

import {
  NOTE_PREFIX, PORTAL_PREFIX, addEdge, addNote, addPortal, emptyBoard, placeBelow, reconcile, removeEdge,
  removeEdgeBetween, removeNote, removePortal, toggleOrchestrator, updateNote, updatePortal,
  type Board, type CanvasNote, type CanvasPortal,
} from "./board";
import type { Box, Rect, Viewport } from "./geometry";

export type WorkMode = "tabs" | "canvas";

interface CanvasState {
  /** Un canvas por ventana y carpeta de proyecto (ver `boardKey`). */
  boards: Record<string, Board>;
  /** Qué vista usa cada carpeta. Preferencia de esta máquina: va a `localStorage`. */
  modes: Record<string, WorkMode>;
  /** Dónde dibujar cada terminal viva del canvas visible, por id de tab. Lo calcula
   *  `CanvasView` en cada movimiento y lo lee `TerminalPanel`. */
  liveRects: Record<string, Rect>;
}

export const useCanvasStore = create<CanvasState>(() => ({ boards: {}, modes: {}, liveRects: {} }));

let windowLabel = "main";

/** La clave de un canvas: la ventana y la carpeta. Por ventana porque cada una tiene sus
 *  tabs; si dos compartieran canvas, cada una borraría los nodos de la otra al reconciliar. */
export function boardKey(cwd: string): string {
  return `${windowLabel}|${comparablePath(cwd)}`;
}

/** La clave del canvas de la carpeta del agente activo. */
export function useActiveBoardKey(): string | null {
  return useTabsStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active ? boardKey(active.cwd) : null;
  });
}

export function useWorkMode(): WorkMode {
  const key = useActiveBoardKey();
  return useCanvasStore((s) => (key ? s.modes[key] ?? "tabs" : "tabs"));
}

const MODES_KEY = "ade-canvas-modes";

export function setWorkMode(key: string, mode: WorkMode): void {
  const modes = { ...useCanvasStore.getState().modes, [key]: mode };
  useCanvasStore.setState({ modes, liveRects: {} });
  try {
    localStorage.setItem(MODES_KEY, JSON.stringify(modes));
  } catch {
    /* no poder recordarlo no impide usarlo */
  }
}

// ── Edición ─────────────────────────────────────────────────────────

function updateBoard(key: string, fn: (b: Board) => Board): void {
  const boards = useCanvasStore.getState().boards;
  const current = boards[key] ?? emptyBoard();
  const next = fn(current);
  if (next === current && key in boards) return;
  useCanvasStore.setState({ boards: { ...boards, [key]: next } });
  scheduleSave(key);
}

export const canvasActions = {
  moveNode: (key: string, id: string, patch: Partial<Box>) =>
    updateBoard(key, (b) => {
      const note = b.notes[id];
      if (note) return updateNote(b, id, { box: { ...note.box, ...patch } });
      const portal = b.portals[id];
      if (portal) return updatePortal(b, id, { box: { ...portal.box, ...patch } });
      const box = b.nodes[id];
      if (!box) return b;
      return { ...b, nodes: { ...b.nodes, [id]: { ...box, ...patch } } };
    }),
  /** Crea una nota y devuelve su id y su nombre final. Con `near`, al lado de ese nodo y
   *  conectada a él. */
  addNote: (key: string, note: { name?: string; content: string; near?: string; at?: { x: number; y: number } }) => {
    const id = `${NOTE_PREFIX}${crypto.randomUUID()}`;
    let name = "";
    updateBoard(key, (b) => {
      const added = addNote(b, { ...note, id });
      name = added.name;
      return added.board;
    });
    return { id, name };
  },
  updateNote: (key: string, id: string, patch: Partial<Omit<CanvasNote, "box">>) =>
    updateBoard(key, (b) => updateNote(b, id, patch)),
  removeNote: (key: string, id: string) => updateBoard(key, (b) => removeNote(b, id)),
  /** Crea un portal y devuelve su id y su nombre final. Con `near`, al lado de ese nodo y
   *  conectado a él. */
  addPortal: (key: string, portal: { name?: string; url?: string; near?: string; at?: { x: number; y: number } }) => {
    const id = `${PORTAL_PREFIX}${crypto.randomUUID()}`;
    let name = "";
    updateBoard(key, (b) => {
      const added = addPortal(b, { ...portal, id });
      name = added.name;
      return added.board;
    });
    return { id, name };
  },
  updatePortal: (key: string, id: string, patch: Partial<Omit<CanvasPortal, "box">>) =>
    updateBoard(key, (b) => updatePortal(b, id, patch)),
  removePortal: (key: string, id: string) => updateBoard(key, (b) => removePortal(b, id)),
  setViewport: (key: string, viewport: Viewport) => updateBoard(key, (b) => ({ ...b, viewport })),
  connect: (key: string, a: string, b: string) => updateBoard(key, (board) => addEdge(board, a, b)),
  disconnect: (key: string, edgeId: string) => updateBoard(key, (board) => removeEdge(board, edgeId)),
  disconnectPair: (key: string, a: string, b: string) => updateBoard(key, (board) => removeEdgeBetween(board, a, b)),
  toggleOrchestrator: (key: string, tabId: string) => updateBoard(key, (board) => toggleOrchestrator(board, tabId)),
  /** Un agente que sumó una orquestadora: debajo de ella y conectado. Si la tab todavía no
   *  tiene nodo (la sincronización corre después), se le da uno primero. */
  recruited: (key: string, tabId: string, near: string, role?: string | null) => updateBoard(key, (board) => {
    const withNode = tabId in board.nodes ? board : reconcile(board, [...Object.keys(board.nodes), tabId]);
    const placed = addEdge(placeBelow(withNode, tabId, near), near, tabId);
    return role ? { ...placed, roles: { ...placed.roles, [tabId]: role } } : placed;
  }),
  setLiveRects: (liveRects: Record<string, Rect>) => {
    const prev = useCanvasStore.getState().liveRects;
    if (JSON.stringify(prev) !== JSON.stringify(liveRects)) useCanvasStore.setState({ liveRects });
  },
};

// ── Guardado ────────────────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Al backend, que es quien hace cumplir las conexiones (ver `canvas/mod.rs`). Con una
 *  pausa: arrastrar un nodo dispara un cambio por cuadro. */
function scheduleSave(key: string): void {
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const board = useCanvasStore.getState().boards[key];
    if (board) invoke("canvas_save", { key, board }).catch(console.error);
  }, 300));
}

/**
 * Guarda YA, sin la pausa. Para los cambios que pide un agente: el backend lee el archivo
 * para decidir permisos, y el agente que acaba de crear una nota la va a querer leer en el
 * comando siguiente — 300 ms después sería tarde.
 */
export async function flushSave(key: string): Promise<void> {
  const pending = timers.get(key);
  if (pending) {
    clearTimeout(pending);
    timers.delete(key);
  }
  const board = useCanvasStore.getState().boards[key];
  if (board) await invoke("canvas_save", { key, board });
}

// ── Sincronización con las tabs ─────────────────────────────────────

/** Pone cada canvas de esta ventana al día con sus tabs abiertas. */
function syncBoards(): void {
  const { tabs, hydrated } = useTabsStore.getState();
  // Antes de restaurar las tabs, "no hay ninguna" es falso: reconciliar ahí borraría los
  // nodos y las conexiones guardadas.
  if (!hydrated) return;
  const byKey = new Map<string, string[]>();
  for (const tab of tabs) {
    const key = boardKey(tab.cwd);
    byKey.set(key, [...(byKey.get(key) ?? []), tab.id]);
  }
  const boards = useCanvasStore.getState().boards;
  const keys = new Set([...byKey.keys(), ...Object.keys(boards).filter((k) => k.startsWith(`${windowLabel}|`))]);
  for (const key of keys) {
    const current = boards[key] ?? emptyBoard();
    const next = reconcile(current, byKey.get(key) ?? [], tabs.map((t) => t.id));
    if (next !== current || !(key in boards)) updateBoard(key, () => next);
  }
}

/** Carga los canvas guardados y los mantiene al día. Se llama una vez, en `AppShell`. */
export function initCanvasSync(label: string): () => void {
  windowLabel = label;
  try {
    const raw = localStorage.getItem(MODES_KEY);
    if (raw) useCanvasStore.setState({ modes: JSON.parse(raw) as Record<string, WorkMode> });
  } catch {
    /* basura en localStorage: todas las carpetas arrancan en abas */
  }

  let disposed = false;
  let unsub: (() => void) | null = null;
  invoke<Record<string, Board>>("canvas_load")
    .catch(() => ({} as Record<string, Board>))
    .then((saved) => {
      if (disposed) return;
      // Solo los de esta ventana: los de las otras son de ellas.
      // Lo que venga del disco se completa: un archivo de otra versión puede no traer todo.
      const mine = Object.fromEntries(
        Object.entries(saved ?? {})
          .filter(([k]) => k.startsWith(`${label}|`))
          .map(([k, b]) => [k, { ...emptyBoard(), ...b, nodes: b?.nodes ?? {}, edges: b?.edges ?? [], orchestrators: b?.orchestrators ?? [], notes: b?.notes ?? {}, portals: b?.portals ?? {}, roles: b?.roles ?? {} }]),
      );
      useCanvasStore.setState({ boards: { ...mine, ...useCanvasStore.getState().boards } });
      unsub = useTabsStore.subscribe(syncBoards);
      syncBoards();
    });

  return () => {
    disposed = true;
    unsub?.();
  };
}
