import { invoke } from "@tauri-apps/api/core";
import { useLocation } from "react-router-dom";
import { create } from "zustand";

import { useChatShell } from "@/app/uiStore";
import { canvasDeviceEngaged } from "@/features/chat/deviceDemand";
import { useTabsStore } from "@/features/tabs/store";
import { comparablePath } from "@/features/tabs/viewTabs";
import { useTeamIndex } from "@/features/chat/team/teamIndex";

import {
  FOLDER_PREFIX, IMAGE_PREFIX, NOTE_PREFIX, PORTAL_PREFIX, TEXT_PREFIX, addEdge, addFolder, addImage, addNote, addPortal,
  addStroke, addText, addThreadNode, removeThreadNode, removeFolder, updateFolder,
  emptyBoard, moveSessionArtifacts, placeInNextGridCell, reconcile, removeEdge, removeEdgeBetween, removeImage, removeNote, removePortal,
  buildMissionTeam, setRole, removeStroke, removeText, toggleOrchestrator, moveTerminals, undoStroke, updateNote, bringToFront, setNoteBox, stackInto, unstack, updatePortal, updateText,
  type Board, type CanvasFolder, type CanvasNote, type CanvasPortal, type CanvasText, type Stroke,
} from "./board";
import { safeViewport, type Box, type Rect, type Viewport } from "./geometry";
import { buildComparisonBoard, type ComparisonNode } from "@/features/compare/layout";

export type WorkMode = "tabs" | "canvas";

interface CanvasState {
  /** Canvases de carpeta y de conversa (ver `boardKey` y `sessionBoardKey`). */
  boards: Record<string, Board>;
  /** Preferência de vista por janela, com entradas antigas por canvas mantidas para leitura. */
  modes: Record<string, WorkMode>;
  /** Misiones (por clave de canvas) cuya vista de abas muestra todos los panes lado a lado. Individual por misión; a `localStorage`. */
  grids: Record<string, boolean>;
  /** Dónde dibujar cada terminal viva del canvas visible, por id de tab. Lo calcula
   *  `CanvasView` en cada movimiento y lo lee `TerminalPanel`. */
  liveRects: Record<string, Rect>;
  desktopRects: Record<string, Rect>;
  desktopFocus: { key: string; id: string; nonce: number } | null;
  /** Pedido de "centrar e selecionar" uma conversa (terminal ou cartão) no canvas dela: a sidebar, uma aba ou o chat. */
  focus: { key: string; ref: string; nonce: number } | null;
  /** O canvas da conversa por protocolo aberta (`thread:<id>`): a aba ativa não diz qual canvas mostrar quando a seleção é um cartão. */
  activeThread: { ref: string; key: string } | null;
  /** Os canvases salvos já foram lidos do disco. Antes disso "a aba não está em nenhum canvas" é falso: quem decide
   *  por isso (adotar abas numa conversa, avisar o orquestrador) espera. */
  loaded: boolean;
  /** Falha ao ler o arquivo. Enquanto existir, nenhuma edição pode substituir o conteúdo do disco. */
  loadError: string | null;
  /** Última falha ao gravar o canvas. */
  saveError: string | null;
}

export const useCanvasStore = create<CanvasState>(() => ({ boards: {}, modes: {}, grids: {}, liveRects: {}, desktopRects: {}, desktopFocus: null, focus: null, activeThread: null, loaded: false, loadError: null, saveError: null }));
let desktopFocusSequence = 0;
let focusSequence = 0;

const pendingUpdates = new Map<string, Array<(board: Board) => Board>>();

let windowLabel = "main";

/** La clave de un canvas: la ventana y la carpeta. Por ventana porque cada una tiene sus
 *  tabs; si dos compartieran canvas, cada una borraría los nodos de la otra al reconciliar. */
export function boardKey(cwd: string): string {
  return `${windowLabel}|${comparablePath(cwd)}`;
}

/** Lo que separa la carpeta de la misión en la clave de un canvas de misión. */
const MISSION_SEP = "#m:";

/** Lo que separa la carpeta de la conversa na chave de um canvas de conversa de projeto. */
const CONV_SEP = "#c:";

/** A chave do canvas de uma conversa de projeto: o da sua pasta, com a conversa colada. */
export function conversationBoardKey(cwd: string, conversationId: string): string {
  return `${boardKey(cwd)}${CONV_SEP}${conversationId}`;
}

/** A conversa de que é um canvas, se for de uma. */
export function conversationOfKey(key: string | null): string | null {
  const at = key?.indexOf(CONV_SEP) ?? -1;
  return key && at >= 0 ? key.slice(at + CONV_SEP.length) : null;
}

/** O que separa a pasta da comparação de modelos na chave do seu canvas (ver `features/compare`). */
const COMPARE_SEP = "#cmp:";
/** Separador de canvases de uma conversa individual. Não define escopo de time no backend. */
export const SESSION_SEP = "#s:";

export function sessionBoardKey(cwd: string, ref: string): string {
  return `${boardKey(cwd)}${SESSION_SEP}${ref}`;
}

export function sessionRefOfKey(key: string | null): string | null {
  const at = key?.indexOf(SESSION_SEP) ?? -1;
  return key && at >= 0 ? key.slice(at + SESSION_SEP.length) : null;
}

/** A chave do canvas de uma comparação de modelos: o da pasta escolhida, com a comparação colada. */
export function compareBoardKey(cwd: string, comparisonId: string): string {
  return `${boardKey(cwd)}${COMPARE_SEP}${comparisonId}`;
}

/** A comparação de que é um canvas, se for de uma. */
export function compareOfKey(key: string | null): string | null {
  const at = key?.indexOf(COMPARE_SEP) ?? -1;
  return key && at >= 0 ? key.slice(at + COMPARE_SEP.length) : null;
}

/** La clave del canvas de una misión en terminales: el de su carpeta, con la misión pegada. */
export function missionBoardKey(cwd: string, missionId: string): string {
  return `${boardKey(cwd)}${MISSION_SEP}${missionId}`;
}

/** La misión de la que es un canvas, si es de una. */
export function missionOfKey(key: string | null): string | null {
  const at = key?.indexOf(MISSION_SEP) ?? -1;
  return key && at >= 0 ? key.slice(at + MISSION_SEP.length) : null;
}

/** Os canvas da missão `missionId` que existem nesta janela. */
export function missionBoardKeysOf(missionId: string): string[] {
  const prefix = `${windowLabel}|`;
  return Object.keys(useCanvasStore.getState().boards).filter((k) => k.startsWith(prefix) && missionOfKey(k) === missionId);
}

/** O canvas da aba: especial legado, time, sessão existente ou a sessão própria. */
export function boardKeyOfTab(tab: { id: string; cwd: string }, boards: Record<string, Board> = useCanvasStore.getState().boards): string {
  const prefix = `${windowLabel}|`;
  for (const [key, board] of Object.entries(boards)) {
    // Primeiro, pertencimento explícito a um canvas especial legado.
    if (key.startsWith(prefix) && (key.includes(MISSION_SEP) || key.includes(CONV_SEP) || key.includes(COMPARE_SEP)) && tab.id in board.nodes) return key;
  }
  const folder = boardKey(tab.cwd);
  const old = boards[folder];
  // Sem a lista de times ainda não se sabe se a aba é integrante (e vai para o canvas do orquestrador) ou
  // não: a conversa antiga fica na pasta até saber, para não ser levada ao canvas errado e lá ficar.
  if (!useTeamIndex.getState().loaded && old && hasSessionArtifacts(old, tab.id)) return folder;
  const liveRefs = new Set(useTabsStore.getState().tabs.map((item) => item.id));
  const team = useTeamIndex.getState().teams.find((item) => item.orchestrator === tab.id || item.members.some((member) => member.member === tab.id));
  // Times promovidos a partir de um canvas de pasta já eram um conjunto manual autorizado:
  // mantenha a pasta como dona para todos, em vez de separar os integrantes na migração.
  if (team?.origin === "canvas" && team.boardKey === folder) return folder;
  // Ligações manuais entre conversas mantêm o grupo na pasta. Outros times seguem a coroa
  // e copiam aditivamente as autorizações para o canvas do orquestrador.
  if (!team && old?.edges?.some((edge) =>
    (edge.a === tab.id && (liveRefs.has(edge.b) || edge.b.startsWith("thread:")))
    || (edge.b === tab.id && (liveRefs.has(edge.a) || edge.a.startsWith("thread:"))))) return folder;
  if (team?.orchestrator && team.orchestrator !== tab.id) {
    const leadRef = team.orchestrator;
    const leadBoard = Object.entries(boards).find(([key, board]) => key.startsWith(prefix)
      && (key.includes(MISSION_SEP) || key.includes(CONV_SEP) || key.includes(COMPARE_SEP))
      && (leadRef in board.nodes || leadRef in board.threads))?.[0];
    if (leadBoard) return leadBoard;
    const storedSpecial = team.boardKey && (team.boardKey.includes(MISSION_SEP) || team.boardKey.includes(CONV_SEP) || team.boardKey.includes(COMPARE_SEP))
      ? team.boardKey
      : null;
    if (storedSpecial) return storedSpecial;
    const leadSession = Object.entries(boards).find(([key, board]) => key.startsWith(prefix)
      && sessionRefOfKey(key) === leadRef && (leadRef in board.nodes || leadRef in board.threads))?.[0];
    if (leadSession) return leadSession;
    const lead = useTabsStore.getState().tabs.find((item) => item.id === leadRef);
    return sessionBoardKey(lead?.cwd ?? team.cwd, leadRef);
  }
  // Uma aba também pode ter sido colocada no canvas #s: de uma conversa por protocolo. Esse
  // nó explícito define o pertencimento, mesmo que o canvas próprio da aba já tenha sido criado.
  const existingSession = Object.entries(boards).find(([key, board]) => key.startsWith(prefix)
    && key.includes(SESSION_SEP) && tab.id in board.nodes)?.[0];
  return existingSession ?? sessionBoardKey(tab.cwd, tab.id);
}

/** A ref tem algo no canvas `board` (nó, cartão, corda, coroa, papel ou marca de subagente)? */
export function hasSessionArtifacts(board: Board, ref: string): boolean {
  return ref in board.nodes || ref in board.threads || board.orchestrators.includes(ref) || board.subagents.includes(ref)
    || Object.prototype.hasOwnProperty.call(board.roles, ref) || board.edges.some((edge) => edge.a === ref || edge.b === ref);
}

/** La misión a la que pertenece una tab (la de su canvas), o `null` si es una tab suelta. */
export function missionOfTab(tab: { id: string; cwd: string }, boards?: Record<string, Board>): string | null {
  return missionOfKey(boardKeyOfTab(tab, boards));
}

/** La clave del canvas del agente activo: el de su misión o el de su carpeta. */
export function useActiveBoardKey(): string | null {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  return useCanvasStore((s) => s.activeThread?.key ?? (active ? boardKeyOfTab(active, s.boards) : null));
}

export function useWorkMode(): WorkMode {
  const key = useActiveBoardKey();
  const windowKey = windowModeKey();
  return useCanvasStore((s) => workModeFor(s.modes, windowKey, key));
}

export function windowModeKey(): string {
  return `@window:${windowLabel}`;
}

/** A entrada por canvas é o formato antigo; só serve de fallback até existir preferência da janela. */
export function workModeFor(modes: Record<string, WorkMode>, windowKey: string, board: string | null): WorkMode {
  if (modes[windowKey]) return modes[windowKey];
  if (!board) return "tabs";
  if (modes[board]) return modes[board];
  const separators = [MISSION_SEP, CONV_SEP, COMPARE_SEP, SESSION_SEP];
  const at = separators.map((sep) => board.indexOf(sep)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const folder = at === undefined ? null : board.slice(0, at);
  return (folder ? modes[folder] : undefined) ?? "tabs";
}

/** `true` quando o canvas está visível: modo `"canvas"`, sem o chat por cima e na rota `/workspace`. */
export function useCanvasActive(): boolean {
  const mode = useWorkMode();
  const chatShell = useChatShell();
  const { pathname } = useLocation();
  return canvasDeviceEngaged(mode, chatShell, pathname);
}

const MODES_KEY = "ade-canvas-modes";
const GRIDS_KEY = "ade-mission-grids";

/** Enciende o apaga la grade de panes de una misión (solo esa: no hay opción global). */
export function setMissionGrid(key: string, on: boolean): void {
  const grids = { ...useCanvasStore.getState().grids, [key]: on };
  if (!on) delete grids[key];
  useCanvasStore.setState({ grids });
  try {
    localStorage.setItem(GRIDS_KEY, JSON.stringify(grids));
  } catch {
    /* no poder recordarlo no impide usarlo */
  }
}

/** Lee lo guardado: solo booleanos `true`, cualquier otra cosa es basura y se ignora. Pura. */
export function parseGrids(raw: string | null): Record<string, boolean> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === true));
  } catch {
    return {};
  }
}

export function setWorkMode(_key: string, mode: WorkMode): void {
  const windowKey = windowModeKey();
  const modes = { ...useCanvasStore.getState().modes, [windowKey]: mode };
  useCanvasStore.setState({ modes, liveRects: {}, desktopRects: {} });
  try {
    localStorage.setItem(MODES_KEY, JSON.stringify(modes));
  } catch {
    /* no poder recordarlo no impide usarlo */
  }
}

// ── Edición ─────────────────────────────────────────────────────────

function updateBoard(key: string, fn: (b: Board) => Board, queueBeforeLoad = true): void {
  const state = useCanvasStore.getState();
  const boards = state.boards;
  const current = boards[key] ?? emptyBoard();
  const next = fn(current);
  if (next === current && key in boards) return;
  useCanvasStore.setState({ boards: { ...boards, [key]: next } });
  if (!state.loaded) {
    if (queueBeforeLoad) pendingUpdates.set(key, [...(pendingUpdates.get(key) ?? []), fn]);
    return;
  }
  scheduleSave(key);
}

export const canvasActions = {
  focusDesktop: (key: string, id: string) => useCanvasStore.setState({ desktopFocus: { key, id, nonce: ++desktopFocusSequence } }),
  /** Dá um cartão à conversa por protocolo `ref` no canvas `key` (num lugar livre; já tendo, não muda nada). */
  addThread: (key: string, ref: string) => updateBoard(key, (b) => addThreadNode(b, ref)),
  /** Leva a ref do canvas antigo para o da sessão (ver `moveSessionArtifacts`): o destino grava antes da origem. */
  moveSessionFrom: (fromKey: string, toKey: string, ref: string) => moveSession(fromKey, toKey, ref),
  removeThread: (key: string, ref: string) => updateBoard(key, (b) => removeThreadNode(b, ref)),
  /** Pede ao canvas `key` que centre e destaque `ref` (a conversa escolhida fora dele). */
  focusRef: (key: string, ref: string) => useCanvasStore.setState({ focus: { key, ref, nonce: ++focusSequence } }),
  moveNode: (key: string, id: string, patch: Partial<Box>) =>
    updateBoard(key, (b) => {
      const thread = b.threads[id];
      if (thread) return { ...b, threads: { ...b.threads, [id]: { ...thread, ...patch } } };
      const note = b.notes[id];
      if (note) return setNoteBox(b, id, patch);
      const portal = b.portals[id];
      if (portal) return updatePortal(b, id, { box: { ...portal.box, ...patch } });
      const text = b.texts[id];
      if (text) return updateText(b, id, { box: { ...text.box, ...patch } });
      const folder = b.folders[id];
      if (folder) return updateFolder(b, id, { box: { ...folder.box, ...patch } });
      const image = b.images[id];
      if (image) return { ...b, images: { ...b.images, [id]: { ...image, box: { ...image.box, ...patch } } } };
      const box = b.nodes[id];
      if (!box) return b;
      return { ...b, nodes: { ...b.nodes, [id]: { ...box, ...patch } } };
    }),
  /** Põe o terminal de uma aba num retângulo escolhido (o desenhado na tela); o nó nasce aí em vez da próxima célula livre. */
  placeNode: (key: string, tabId: string, box: Box) =>
    updateBoard(key, (b) => ({ ...b, nodes: { ...b.nodes, [tabId]: box } })),
  /** Crea una nota y devuelve su id y su nombre final. Con `near`, al lado de ese nodo y
   *  conectada a él. */
  addNote: (key: string, note: { name?: string; content: string; near?: string; at?: { x: number; y: number }; stackWith?: string; size?: { w: number; h: number } }) => {
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
  /** Apila la nota `id` sobre `ontoId`. */
  stackNote: (key: string, id: string, ontoId: string) => updateBoard(key, (b) => stackInto(b, id, ontoId)),
  /** Pone una nota al frente de su pila. */
  bringNoteToFront: (key: string, id: string) => updateBoard(key, (b) => bringToFront(b, id)),
  /** Suelta una nota de su pila. */
  unstackNote: (key: string, id: string) => updateBoard(key, (b) => unstack(b, id)),
  /** Crea un portal y devuelve su id y su nombre final. Con `near`, al lado de ese nodo y
   *  conectado a él. */
  addPortal: (key: string, portal: { name?: string; url?: string; near?: string; at?: { x: number; y: number }; kind?: "android" | "gemini" | "ios"; avd?: string; udid?: string; size?: { w: number; h: number }; viewport?: { width: number; height: number } }) => {
    const existing = portal.kind === "gemini" && Object.entries(useCanvasStore.getState().boards[key]?.portals ?? {}).find(([, p]) => p.kind === "gemini");
    if (existing) return { id: existing[0], name: existing[1].name };
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
  addText: (key: string, at: { x: number; y: number }, box?: { w: number; h: number }) => {
    const id = `${TEXT_PREFIX}${crypto.randomUUID()}`;
    updateBoard(key, (b) => addText(b, { id, at, box }));
    return id;
  },
  updateText: (key: string, id: string, patch: Partial<Omit<CanvasText, "box">>) =>
    updateBoard(key, (b) => updateText(b, id, patch)),
  removeText: (key: string, id: string) => updateBoard(key, (b) => removeText(b, id)),
  addImage: (key: string, img: { name: string; asset: string; width: number; height: number; at: { x: number; y: number } }) => {
    const id = `${IMAGE_PREFIX}${crypto.randomUUID()}`;
    updateBoard(key, (b) => addImage(b, { ...img, id }));
    return id;
  },
  removeImage: (key: string, id: string) => updateBoard(key, (b) => removeImage(b, id)),
  addFolder: (key: string, folder: { path: string; name: string; at: { x: number; y: number }; size?: { w: number; h: number } }) => {
    const id = `${FOLDER_PREFIX}${crypto.randomUUID()}`;
    updateBoard(key, (b) => addFolder(b, { ...folder, id }));
    return id;
  },
  updateFolder: (key: string, id: string, patch: Partial<Omit<CanvasFolder, "box">>) =>
    updateBoard(key, (b) => updateFolder(b, id, patch)),
  removeFolder: (key: string, id: string) => updateBoard(key, (b) => removeFolder(b, id)),
  addStroke: (key: string, stroke: Omit<Stroke, "id">) =>
    updateBoard(key, (b) => addStroke(b, { ...stroke, id: crypto.randomUUID() })),
  removeStroke: (key: string, id: string) => updateBoard(key, (b) => removeStroke(b, id)),
  undoStroke: (key: string) => updateBoard(key, (b) => undoStroke(b)),
  setViewport: (key: string, viewport: Viewport) => updateBoard(key, (b) => ({ ...b, viewport: safeViewport(viewport, b.viewport) })),
  connect: (key: string, a: string, b: string) => updateBoard(key, (board) => addEdge(board, a, b)),
  disconnect: (key: string, edgeId: string) => updateBoard(key, (board) => removeEdge(board, edgeId)),
  disconnectPair: (key: string, a: string, b: string) => updateBoard(key, (board) => removeEdgeBetween(board, a, b)),
  toggleOrchestrator: (key: string, tabId: string) => updateBoard(key, (board) => toggleOrchestrator(board, tabId)),
  /** Leva terminais de um canvas para outro, com lugar, ligações, papel e coroa (ver `moveTerminals`). O modo
   *  (abas ou canvas) vai junto, se o destino ainda não tiver um. */
  moveTerminals: (fromKey: string, toKey: string, tabIds: string[]) => {
    const boards = useCanvasStore.getState().boards;
    const moved = moveTerminals(boards[fromKey] ?? emptyBoard(), boards[toKey] ?? emptyBoard(), tabIds);
    updateBoard(toKey, () => moved.to);
    updateBoard(fromKey, () => moved.from);
    const modes = useCanvasStore.getState().modes;
    if (!(windowModeKey() in modes) && modes[fromKey]) setWorkMode(toKey, modes[fromKey]);
  },
  /** O que o terminal é: papel (`null` = o orquestrador decide) e se é subagente. */
  setRole: (key: string, tabId: string, role: string | null, subagent: boolean) =>
    updateBoard(key, (board) => setRole(board, tabId, role, subagent)),
  /** Posiciona o recruit na proxima celula livre e o conecta a quem o recrutou. */
  recruited: (key: string, tabId: string, near: string, role?: string | null) => updateBoard(key, (board) => {
    const withNode = tabId in board.nodes ? board : reconcile(board, [...Object.keys(board.nodes), tabId]);
    const leadId = withNode.orchestrators.includes(near) ? near : withNode.orchestrators[0] ?? near;
    const linked = withNode.edges.flatMap((edge) =>
      edge.a === leadId ? [edge.b] : edge.b === leadId ? [edge.a] : [],
    );
    const members = linked.filter((id) => id !== tabId && id in withNode.nodes);
    const teamIds = [leadId, ...new Set(members)];
    const placed = addEdge(placeInNextGridCell(withNode, teamIds, tabId), near, tabId);
    return role ? { ...placed, roles: { ...placed.roles, [tabId]: role } } : placed;
  }),
  /** El canvas de una misión en terminales: el orquestador y su equipo, ya conectados y con su papel.
   *  `key` es `missionBoardKey`. Crea el canvas si no existe. */
  buildMissionTeam: (key: string, leadId: string, members: { tabId: string; roleId?: string | null; subagent?: boolean }[]) =>
    updateBoard(key, (board) => buildMissionTeam(board, leadId, members)),
  /** O canvas de uma comparação de modelos: os terminais lado a lado sob o título (ver `compare/layout.ts`). */
  buildComparison: (key: string, titleId: string, title: string, entries: ComparisonNode[]) =>
    updateBoard(key, (board) => buildComparisonBoard(board, titleId, title, entries)),
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
  if (!useCanvasStore.getState().loaded || useCanvasStore.getState().loadError) return;
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const state = useCanvasStore.getState();
    if (!state.loaded || state.loadError) return;
    const board = useCanvasStore.getState().boards[key];
    if (board) {
      invoke("canvas_save", { key, board })
        .then(() => useCanvasStore.setState({ saveError: null }))
        .catch((error: unknown) => useCanvasStore.setState({ saveError: String(error) }));
    }
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
  const state = useCanvasStore.getState();
  if (!state.loaded || state.loadError) return;
  const board = useCanvasStore.getState().boards[key];
  if (board) {
    try {
      await invoke("canvas_save", { key, board });
      useCanvasStore.setState({ saveError: null });
    } catch (error) {
      useCanvasStore.setState({ saveError: String(error) });
      throw error;
    }
  }
}

/** Grava os canvas com debounce pendente antes de a janela fechar. */
export async function flushCanvasSavesForClose(): Promise<void> {
  await Promise.all([...timers.keys()].map((key) => flushSave(key)));
}

// ── Sincronización con las tabs ─────────────────────────────────────

/** Move a ref do canvas `fromKey` para `toKey`. O destino grava primeiro: no meio, a corda existe nos dois, nunca em nenhum. */
function moveSession(fromKey: string, toKey: string, ref: string): void {
  // Antes de o canvas.json chegar não há o que mover: a cópia em memória ainda não é a do disco.
  if (!useCanvasStore.getState().loaded) return;
  const boards = useCanvasStore.getState().boards;
  const source = boards[fromKey];
  if (!source) return;
  const moved = moveSessionArtifacts(source, boards[toKey] ?? emptyBoard(), ref);
  if (moved.source === source) return;
  updateBoard(toKey, () => moved.target);
  updateBoard(fromKey, () => moved.source);
}

/** Pone cada canvas de esta ventana al día con sus tabs abiertas. */
function syncBoards(): void {
  const { tabs, hydrated } = useTabsStore.getState();
  // Antes de restaurar las tabs, "no hay ninguna" es falso: reconciliar ahí borraría los
  // nodos y las conexiones guardadas.
  if (!hydrated) return;
  const byKey = new Map<string, string[]>();
  const boards = useCanvasStore.getState().boards;
  for (const tab of tabs) {
    const key = boardKeyOfTab(tab, boards);
    byKey.set(key, [...(byKey.get(key) ?? []), tab.id]);
    // A conversa que sai da pasta para o canvas próprio (ou o do orquestrador) leva o que é dela: nó, cordas,
    // coroa, papel e marca. Sem isso, o `reconcile` da pasta tiraria coroa e papel, e as cordas que ficassem lá
    // continuariam autorizando depois de cortadas no canvas novo.
    const folder = boardKey(tab.cwd);
    const source = boards[folder];
    if (key !== folder && key.includes(SESSION_SEP) && source && hasSessionArtifacts(source, tab.id)) moveSession(folder, key, tab.id);
  }
  const keys = new Set([...byKey.keys(), ...Object.keys(boards).filter((k) => k.startsWith(`${windowLabel}|`))]);
  for (const key of keys) {
    const current = useCanvasStore.getState().boards[key] ?? emptyBoard();
    const next = reconcile(current, byKey.get(key) ?? [], tabs.map((t) => t.id));
    if (next !== current || !(key in boards)) updateBoard(key, () => next, false);
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

  try {
    useCanvasStore.setState({ grids: parseGrids(localStorage.getItem(GRIDS_KEY)) });
  } catch {
    /* sin localStorage: ninguna misión en grade */
  }

  let disposed = false;
  let unsub: (() => void) | null = null;
  invoke<Record<string, Board>>("canvas_load")
    .then((saved) => {
      if (disposed) return;
      // Solo los de esta ventana: los de las otras son de ellas.
      // Lo que venga del disco se completa: un archivo de otra versión puede no traer todo.
      const mine = Object.fromEntries(
        Object.entries(saved ?? {})
          .filter(([k]) => k.startsWith(`${label}|`))
          .map(([k, b]) => [k, { ...emptyBoard(), ...b, viewport: safeViewport(b?.viewport), nodes: b?.nodes ?? {}, edges: b?.edges ?? [], orchestrators: b?.orchestrators ?? [], notes: b?.notes ?? {}, portals: b?.portals ?? {}, texts: b?.texts ?? {}, images: b?.images ?? {}, folders: b?.folders ?? {}, drawings: b?.drawings ?? [], threads: b?.threads ?? {}, roles: b?.roles ?? {}, subagents: b?.subagents ?? [] }]),
      );
      const current = useCanvasStore.getState();
      const merged = { ...mine };
      if (!current.loadError) {
        for (const [key, board] of Object.entries(current.boards)) {
          if (!pendingUpdates.has(key)) merged[key] = board;
        }
      }
      const changed = [...pendingUpdates.keys()];
      for (const [key, updates] of pendingUpdates) {
        let board = merged[key] ?? emptyBoard();
        for (const update of updates) board = update(board);
        merged[key] = board;
      }
      pendingUpdates.clear();
      useCanvasStore.setState({ boards: merged, loaded: true, loadError: null, saveError: null });
      const offTabs = useTabsStore.subscribe(syncBoards);
      // A lista de times chegou ou mudou: quem é integrante vai para o canvas do orquestrador (ver `boardKeyOfTab`).
      const offTeams = useTeamIndex.subscribe((state, prev) => { if (state.teams !== prev.teams || state.loaded !== prev.loaded) syncBoards(); });
      unsub = () => { offTabs(); offTeams(); };
      syncBoards();
      for (const key of changed) scheduleSave(key);
    })
    .catch((error: unknown) => {
      if (disposed) return;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      useCanvasStore.setState({ loadError: String(error), loaded: false });
      // A reconciliação continua em memória para as abas funcionarem; scheduleSave bloqueia o disco.
      unsub = useTabsStore.subscribe(syncBoards);
      syncBoards();
    });

  return () => {
    disposed = true;
    unsub?.();
  };
}
