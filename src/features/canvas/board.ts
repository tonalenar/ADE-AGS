import { GAP, nextFreeBox, type Box, type Viewport } from "./geometry";

/** Una conexión entre dos terminales. Sin sentido: los dos lados pueden hablarse. */
export interface CanvasEdge {
  id: string;
  a: string;
  b: string;
}

/** Una nota en el canvas. Conectada a un agente, ese agente la lee y la escribe con
 *  `ccode note ...` (ver `ipc/commands/notes.rs`). */
export interface CanvasNote {
  name: string;
  content: string;
  box: Box;
}

/** Los ids de nota llevan este prefijo: así nunca chocan con un id de tab, y el backend
 *  sabe qué punta de una conexión es una nota sin leer nada más. */
export const NOTE_PREFIX = "note-";

export function isNoteId(id: string): boolean {
  return id.startsWith(NOTE_PREFIX);
}

/** El canvas de un proyecto. Las claves de `nodes` son ids de tab. */
export interface Board {
  nodes: Record<string, Box>;
  /** Las notas, por id (`note-…`). No dependen de ninguna tab: se quedan aunque se cierren. */
  notes: Record<string, CanvasNote>;
  edges: CanvasEdge[];
  viewport: Viewport;
  /** Las orquestadoras: alcanzan a todo su equipo y pueden sumar agentes y conectarlos. */
  orchestrators: string[];
}

export function emptyBoard(): Board {
  return { nodes: {}, notes: {}, edges: [], viewport: { x: 40, y: 40, zoom: 1 }, orchestrators: [] };
}

/**
 * Pone el canvas al día con las tabs abiertas: cada tab nueva recibe un lugar libre, y las
 * que se cerraron se van con sus conexiones (una conexión con alguien que ya no existe
 * sería un permiso colgando). Devuelve el MISMO objeto si no cambió nada, para que quien
 * lo guarda no escriba por gusto.
 */
export function reconcile(board: Board, tabIds: string[]): Board {
  const open = new Set(tabIds);
  const kept = Object.entries(board.nodes).filter(([id]) => open.has(id));
  const missing = tabIds.filter((id) => !(id in board.nodes));
  // Las notas no se cierran con ninguna tab: una conexión con una nota vale mientras la
  // nota exista.
  const alive = (id: string) => open.has(id) || id in board.notes;
  const edges = board.edges.filter((e) => alive(e.a) && alive(e.b));
  const orchestrators = board.orchestrators.filter((id) => open.has(id));

  if (
    missing.length === 0 && kept.length === Object.keys(board.nodes).length &&
    edges.length === board.edges.length && orchestrators.length === board.orchestrators.length
  ) {
    return board;
  }

  const nodes: Record<string, Box> = Object.fromEntries(kept);
  const noteBoxes = Object.values(board.notes).map((n) => n.box);
  for (const id of missing) nodes[id] = nextFreeBox([...Object.values(nodes), ...noteBoxes]);
  return { ...board, nodes, edges, orchestrators };
}

/** Conecta dos terminales. Una consigo misma o una conexión repetida no hacen nada. */
export function addEdge(board: Board, a: string, b: string, id: string = crypto.randomUUID()): Board {
  if (a === b) return board;
  const exists = board.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  if (exists) return board;
  return { ...board, edges: [...board.edges, { id, a, b }] };
}

/** Quita la conexión entre `a` y `b`, en el sentido que sea. */
export function removeEdgeBetween(board: Board, a: string, b: string): Board {
  const edge = board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  return edge ? removeEdge(board, edge.id) : board;
}

export function toggleOrchestrator(board: Board, tabId: string): Board {
  const on = board.orchestrators.includes(tabId);
  return {
    ...board,
    orchestrators: on ? board.orchestrators.filter((id) => id !== tabId) : [...board.orchestrators, tabId],
  };
}

/**
 * Pone a `tabId` debajo de `near` (su orquestadora): en la fila de abajo, en la primera
 * columna libre hacia la derecha. Así el equipo se lee de arriba hacia abajo, como un
 * organigrama, en vez de quedar donde caiga.
 */
export function placeBelow(board: Board, tabId: string, near: string): Board {
  const anchor = board.nodes[near];
  const box = board.nodes[tabId];
  if (!anchor || !box) return board;
  const others = Object.entries(board.nodes).filter(([id]) => id !== tabId).map(([, b]) => b);
  const y = anchor.y + anchor.h + GAP;
  for (let k = 0; k < 50; k++) {
    const candidate = { x: anchor.x + k * (box.w + GAP), y, w: box.w, h: box.h };
    const free = !others.some((o) => candidate.x < o.x + o.w && o.x < candidate.x + candidate.w && candidate.y < o.y + o.h && o.y < candidate.y + candidate.h);
    if (free) return { ...board, nodes: { ...board.nodes, [tabId]: candidate } };
  }
  return board;
}

export function removeEdge(board: Board, id: string): Board {
  const edges = board.edges.filter((e) => e.id !== id);
  return edges.length === board.edges.length ? board : { ...board, edges };
}

/** Con quién está conectada una terminal, en este canvas. */
export function neighbors(board: Board, tabId: string): string[] {
  return board.edges.flatMap((e) => (e.a === tabId ? [e.b] : e.b === tabId ? [e.a] : []));
}

// ── Notas ───────────────────────────────────────────────────────────

/** Dónde está un nodo, sea terminal o nota. */
export function boxOf(board: Board, id: string): Box | undefined {
  return board.nodes[id] ?? board.notes[id]?.box;
}

export const NOTE_SIZE = { w: 320, h: 240 };
export const NOTE_MIN = { w: 200, h: 120 };

/** Un nombre que nadie más usa en este canvas: `wanted` o, si está tomado, `wanted 2`… */
export function uniqueNoteName(board: Board, wanted: string, except?: string): string {
  const taken = new Set(
    Object.entries(board.notes).filter(([id]) => id !== except).map(([, n]) => n.name.toLowerCase()),
  );
  const base = wanted.trim() || "Nota";
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k++) {
    const candidate = `${base} ${k}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** El nombre por defecto de una nota: su primera línea con texto, sin `#`, cortada. */
export function defaultNoteName(content: string): string {
  const first = content.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 0);
  return first ? first.slice(0, 40) : "Nota";
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Agrega una nota. Con `near`, a la derecha de ese nodo (bajando hasta un hueco libre) y
 * conectada a él: es la nota que un agente crea para sí mismo. Devuelve el canvas y el
 * nombre final, que puede no ser el pedido si ya estaba tomado.
 */
export function addNote(
  board: Board,
  note: { id: string; name?: string; content: string; near?: string; at?: { x: number; y: number } },
): { board: Board; name: string } {
  const name = uniqueNoteName(board, note.name ?? defaultNoteName(note.content));
  const others = [...Object.values(board.nodes), ...Object.values(board.notes).map((n) => n.box)];
  const anchor = note.near ? boxOf(board, note.near) : undefined;
  let box: Box;
  if (anchor) {
    box = { x: anchor.x + anchor.w + GAP, y: anchor.y, ...NOTE_SIZE };
    for (let k = 1; k <= 50 && others.some((o) => overlaps(o, box)); k++) {
      box = { ...box, y: anchor.y + k * (NOTE_SIZE.h + GAP / 2) };
    }
  } else if (note.at) {
    box = { x: Math.round(note.at.x), y: Math.round(note.at.y), ...NOTE_SIZE };
  } else {
    box = nextFreeBox(others, NOTE_SIZE);
  }
  const next = { ...board, notes: { ...board.notes, [note.id]: { name, content: note.content, box } } };
  return { board: anchor && note.near ? addEdge(next, note.near, note.id) : next, name };
}

/** Cambia una nota. Un nombre repetido se desambigua en vez de fallar. */
export function updateNote(board: Board, id: string, patch: Partial<CanvasNote>): Board {
  const note = board.notes[id];
  if (!note) return board;
  const named = patch.name !== undefined ? { ...patch, name: uniqueNoteName(board, patch.name, id) } : patch;
  return { ...board, notes: { ...board.notes, [id]: { ...note, ...named } } };
}

/** Quita una nota y sus conexiones. */
export function removeNote(board: Board, id: string): Board {
  if (!(id in board.notes)) return board;
  const notes = { ...board.notes };
  delete notes[id];
  return { ...board, notes, edges: board.edges.filter((e) => e.a !== id && e.b !== id) };
}
