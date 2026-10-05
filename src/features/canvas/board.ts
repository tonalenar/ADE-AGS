import { GAP, nextFreeBox, type Box, type Viewport } from "./geometry";

/** Una conexión entre dos terminales. Sin sentido: los dos lados pueden hablarse. */
export interface CanvasEdge {
  id: string;
  a: string;
  b: string;
}

/** Una nota en el canvas. Conectada a un agente, ese agente la lee y la escribe con
 *  `ags note ...` (ver `ipc/commands/notes.rs`). */
export interface CanvasNote {
  name: string;
  content: string;
  box: Box;
  /** La pila a la que pertenece (las notas de una pila comparten caja y se ve una sola, la
   *  del frente). Ausente = una nota suelta. */
  stack?: string;
  /** Es la que se ve de su pila. */
  front?: boolean;
}

/** Los ids de nota llevan este prefijo: así nunca chocan con un id de tab, y el backend
 *  sabe qué punta de una conexión es una nota sin leer nada más. */
export const NOTE_PREFIX = "note-";

export function isNoteId(id: string): boolean {
  return id.startsWith(NOTE_PREFIX);
}

/** Un portal: un navegador como nodo del canvas, que los agentes conectados manejan con
 *  `ags portal ...`. La URL se guarda para reabrirlo donde estaba. */
export interface CanvasPortal {
  name: string;
  url: string;
  box: Box;
  /** `android` = la pantalla de un emulador o teléfono (ver `DeviceNode`), no un navegador. */
  kind?: "android";
  /** El dispositivo de adb que muestra; sin él, el único que haya. */
  serial?: string;
  /** El emulador (AVD) que arranca. */
  avd?: string;
}

export const PORTAL_PREFIX = "portal-";

export function isPortalId(id: string): boolean {
  return id.startsWith(PORTAL_PREFIX);
}

/** Un texto suelto sobre el canvas: un rótulo, sin marco. Decoración: ningún agente lo ve. */
export interface CanvasText {
  text: string;
  /** Tamaño de la letra, en px del canvas. */
  size: number;
  box: Box;
}

export const TEXT_PREFIX = "text-";

/** Una imagen puesta en el canvas. El archivo vive en el disco (ver `canvas::assets`); acá
 *  solo su id: si no, cada movimiento reescribiría la imagen entera en el canvas. */
export interface CanvasImage {
  name: string;
  asset: string;
  box: Box;
}

export const IMAGE_PREFIX = "image-";

/** Una carpeta del disco puesta en el canvas: su árbol de archivos a la vista. Solo se lee;
 *  ningún agente la ve. `open` son las subcarpetas desplegadas. */
export interface CanvasFolder {
  path: string;
  name: string;
  open: string[];
  box: Box;
}

export const FOLDER_PREFIX = "folder-";
export const FOLDER_SIZE = { w: 300, h: 380 };
export const FOLDER_MIN = { w: 200, h: 160 };

/** Un trazo a mano alzada. `points` va plano `[x0, y0, x1, y1, …]` en coordenadas del canvas. */
export interface Stroke {
  id: string;
  points: number[];
  color: string;
  width: number;
}

/** Los nodos que no son terminales: el canvas los mueve y guarda, pero no dependen de
 *  ninguna tab. */
export function isFreeNodeId(id: string): boolean {
  return id.startsWith(NOTE_PREFIX) || id.startsWith(PORTAL_PREFIX) || id.startsWith(TEXT_PREFIX) || id.startsWith(IMAGE_PREFIX) ||
    id.startsWith(FOLDER_PREFIX);
}

/** El canvas de un proyecto. Las claves de `nodes` son ids de tab. */
export interface Board {
  nodes: Record<string, Box>;
  /** Las notas, por id (`note-…`). No dependen de ninguna tab: se quedan aunque se cierren. */
  notes: Record<string, CanvasNote>;
  /** Los portales, por id (`portal-…`). Como las notas, no dependen de ninguna tab. */
  portals: Record<string, CanvasPortal>;
  /** Rótulos, imágenes y trazos: decoración del canvas. Los agentes no los ven. */
  texts: Record<string, CanvasText>;
  images: Record<string, CanvasImage>;
  folders: Record<string, CanvasFolder>;
  drawings: Stroke[];
  /** El papel con que se recrutó cada agente (id de tab → nombre del papel). Solo una
   *  etiqueta para el nodo: no da ni quita permisos. */
  roles: Record<string, string>;
  edges: CanvasEdge[];
  viewport: Viewport;
  /** Las orquestadoras: alcanzan a todo su equipo y pueden sumar agentes y conectarlos. */
  orchestrators: string[];
}

export function emptyBoard(): Board {
  return { nodes: {}, notes: {}, portals: {}, texts: {}, images: {}, folders: {}, drawings: [], roles: {}, edges: [], viewport: { x: 40, y: 40, zoom: 1 }, orchestrators: [] };
}

/**
 * Pone el canvas al día con las tabs abiertas: cada tab nueva recibe un lugar libre, y las
 * que se cerraron se van con sus conexiones (una conexión con alguien que ya no existe
 * sería un permiso colgando). Devuelve el MISMO objeto si no cambió nada, para que quien
 * lo guarda no escriba por gusto.
 */
export function reconcile(board: Board, tabIds: string[], allTabIds: string[] = tabIds): Board {
  const open = new Set(tabIds);
  const kept = Object.entries(board.nodes).filter(([id]) => open.has(id));
  const missing = tabIds.filter((id) => !(id in board.nodes));
  // Las notas no se cierran con ninguna tab: una conexión con una nota vale mientras la
  // nota exista.
  // Una conexión puede llegar a un agente de OTRO piso (otro canvas de la misma ventana):
  // vale mientras ese agente siga abierto, aunque no tenga nodo acá.
  const anywhere = new Set(allTabIds);
  const alive = (id: string) => open.has(id) || anywhere.has(id) || id in board.notes || id in board.portals;
  const edges = board.edges.filter((e) => alive(e.a) && alive(e.b));
  const orchestrators = board.orchestrators.filter((id) => open.has(id));
  // El papel de una tab cerrada se va con ella.
  const roleIds = Object.keys(board.roles);
  const roles = roleIds.every((id) => open.has(id))
    ? board.roles
    : Object.fromEntries(Object.entries(board.roles).filter(([id]) => open.has(id)));

  if (
    missing.length === 0 && kept.length === Object.keys(board.nodes).length &&
    edges.length === board.edges.length && orchestrators.length === board.orchestrators.length &&
    roles === board.roles
  ) {
    return board;
  }

  const nodes: Record<string, Box> = Object.fromEntries(kept);
  const noteBoxes = [...Object.values(board.notes), ...Object.values(board.portals)].map((n) => n.box);
  for (const id of missing) nodes[id] = nextFreeBox([...Object.values(nodes), ...noteBoxes]);
  return { ...board, nodes, edges, orchestrators, roles };
}

/**
 * Arma el canvas de una misión en terminales: el orquestador (con su corona) y su equipo en
 * una GRILLA DE DOS FILAS que se llena por columnas, en el orden en que se abren: el 1.º
 * arriba, el 2.º debajo de él, el 3.º a la derecha del 1.º, el 4.º debajo del 3.º, y así.
 * Cada integrante queda conectado con el orquestador y con el papel que cumple. Los nodos
 * que no tenían lugar lo reciben; un papel en blanco no se marca. Pura.
 */
export function buildMissionTeam(
  board: Board,
  leadId: string,
  members: { tabId: string; roleId?: string | null }[],
): Board {
  const ids = [leadId, ...members.map((m) => m.tabId)];
  let next = reconcile(board, ids, ids);
  next = { ...next, orchestrators: next.orchestrators.includes(leadId) ? next.orchestrators : [...next.orchestrators, leadId] };
  next = placeInGrid(next, ids);
  for (const m of members) {
    next = addEdge(next, leadId, m.tabId);
    if (m.roleId) next = { ...next, roles: { ...next.roles, [m.tabId]: m.roleId } };
  }
  return next;
}

/** Cuántas filas tiene la grilla de una misión. */
export const MISSION_GRID_ROWS = 2;

/** La celda (columna, fila) del integrante `index` en la grilla de dos filas, por columnas. Pura. */
export function gridCell(index: number, rows = MISSION_GRID_ROWS): { col: number; row: number } {
  return { col: Math.floor(index / rows), row: index % rows };
}

/**
 * Pone las terminales `ids` en la grilla de la misión (ver `gridCell`), empezando donde está
 * la primera. Las celdas miden lo que la terminal más grande, así nada se tapa. Si la grilla
 * tapa algo que no es del equipo, baja entera (nunca parte el equipo). Pura.
 */
export function placeInGrid(board: Board, ids: string[]): Board {
  const first = board.nodes[ids[0]];
  if (!first || ids.some((id) => !board.nodes[id])) return board;
  const team = new Set(ids);
  const others = [
    ...Object.entries(board.nodes).filter(([id]) => !team.has(id)).map(([, b]) => b),
    ...Object.values(board.notes).map((n) => n.box),
    ...Object.values(board.portals).map((n) => n.box),
  ];
  const cellW = Math.max(...ids.map((id) => board.nodes[id].w)) + GAP;
  const cellH = Math.max(...ids.map((id) => board.nodes[id].h)) + GAP;
  for (let k = 0; k < 50; k++) {
    const top = first.y + k * cellH;
    const placed: Record<string, Box> = {};
    ids.forEach((id, i) => {
      const { col, row } = gridCell(i);
      const { w, h } = board.nodes[id];
      placed[id] = { x: first.x + col * cellW, y: top + row * cellH, w, h };
    });
    const clear = Object.values(placed).every(
      (c) => !others.some((o) => c.x < o.x + o.w && o.x < c.x + c.w && c.y < o.y + o.h && o.y < c.y + c.h),
    );
    if (clear) return { ...board, nodes: { ...board.nodes, ...placed } };
  }
  return board;
}

/** Posiciona um recruit na primeira célula livre depois do time atual, sem mover panes existentes. */
export function placeInNextGridCell(board: Board, memberIds: string[], tabId: string): Board {
  const ids = [...new Set(memberIds.filter((id) => id !== tabId))];
  const first = board.nodes[ids[0]];
  const recruit = board.nodes[tabId];
  if (!first || !recruit || ids.some((id) => !board.nodes[id])) return board;

  const gridIds = [...ids, tabId];
  const cellW = Math.max(...gridIds.map((id) => board.nodes[id].w)) + GAP;
  const cellH = Math.max(...gridIds.map((id) => board.nodes[id].h)) + GAP;
  const others = [
    ...Object.entries(board.nodes).filter(([id]) => id !== tabId).map(([, box]) => box),
    ...Object.values(board.notes).map((note) => note.box),
    ...Object.values(board.portals).map((portal) => portal.box),
  ];

  for (let index = ids.length; index < ids.length + 1000; index++) {
    const { col, row } = gridCell(index);
    const candidate = {
      x: first.x + col * cellW,
      y: first.y + row * cellH,
      w: recruit.w,
      h: recruit.h,
    };
    if (!others.some((other) => overlaps(candidate, other))) {
      return { ...board, nodes: { ...board.nodes, [tabId]: candidate } };
    }
  }
  return board;
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
  return board.nodes[id] ?? board.notes[id]?.box ?? board.portals[id]?.box ?? board.texts[id]?.box ?? board.images[id]?.box ?? board.folders[id]?.box;
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
  note: { id: string; name?: string; content: string; near?: string; at?: { x: number; y: number }; stackWith?: string },
): { board: Board; name: string } {
  const name = uniqueNoteName(board, note.name ?? defaultNoteName(note.content));
  const others = allBoxes(board);
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
  const edged = anchor && note.near ? addEdge(next, note.near, note.id) : next;
  // `stackWith`: nace dentro de la pila de otra nota (y no se crea al lado de nadie).
  return { board: note.stackWith && board.notes[note.stackWith] ? stackInto(edged, note.id, note.stackWith) : edged, name };
}

// ── Pilas de notas ──────────────────────────────────────────────────

/** Las notas de una pila, en el orden en que se crearon. */
export function stackMembers(board: Board, stack: string | undefined): string[] {
  if (!stack) return [];
  return Object.entries(board.notes).filter(([, n]) => n.stack === stack).map(([id]) => id);
}

/** ¿Está tapada por otra de su pila? Esas no se dibujan (los agentes las siguen viendo). */
export function isHiddenNote(board: Board, id: string): boolean {
  const n = board.notes[id];
  return !!n && !!n.stack && !n.front;
}

/** La nota que se ve en lugar de `id`: ella misma, o la del frente de su pila. */
export function shownNote(board: Board, id: string): string {
  const n = board.notes[id];
  if (!n || !n.stack || n.front) return id;
  return stackMembers(board, n.stack).find((m) => board.notes[m].front) ?? id;
}

/** Saca una nota de su pila. Si la pila queda con una sola, se disuelve; si era la del frente, pasa otra. */
function leaveStack(board: Board, id: string): Board {
  const note = board.notes[id];
  if (!note?.stack) return board;
  const rest = stackMembers(board, note.stack).filter((m) => m !== id);
  const notes = { ...board.notes };
  const { stack: _s, front: _f, ...plain } = note;
  notes[id] = plain;
  if (rest.length === 1) {
    const { stack: _s2, front: _f2, ...single } = notes[rest[0]];
    notes[rest[0]] = single;
  } else if (rest.length > 1 && !rest.some((m) => notes[m].front)) {
    notes[rest[0]] = { ...notes[rest[0]], front: true };
  }
  return { ...board, notes };
}

/** Pone `id` al frente de su pila. */
export function bringToFront(board: Board, id: string): Board {
  const note = board.notes[id];
  if (!note?.stack || note.front) return board;
  const notes = { ...board.notes };
  for (const m of stackMembers(board, note.stack)) notes[m] = { ...notes[m], front: m === id };
  return { ...board, notes };
}

/**
 * Apila `id` encima de `ontoId`: pasa a su pila (la crea si `ontoId` estaba suelta), toma
 * su caja y queda al frente. Los agentes siguen viendo cada nota por separado.
 */
export function stackInto(board: Board, id: string, ontoId: string): Board {
  const note = board.notes[id];
  const onto = board.notes[ontoId];
  if (!note || !onto || id === ontoId) return board;
  if (note.stack && note.stack === onto.stack) return bringToFront(board, id);
  const left = leaveStack(board, id);
  const target = left.notes[ontoId];
  const stack = target.stack ?? ontoId;
  const notes = { ...left.notes };
  for (const m of stackMembers(left, stack)) notes[m] = { ...notes[m], front: false };
  notes[ontoId] = { ...notes[ontoId], stack, front: false };
  notes[id] = { ...notes[id], stack, front: true, box: { ...target.box } };
  return { ...left, notes };
}

/** Suelta una nota de su pila, un poco corrida para que se vea que es otra. */
export function unstack(board: Board, id: string): Board {
  const note = board.notes[id];
  if (!note?.stack) return board;
  const left = leaveStack(board, id);
  const box = { ...note.box, x: note.box.x + 40, y: note.box.y + 40 };
  return { ...left, notes: { ...left.notes, [id]: { ...left.notes[id], box } } };
}

/** Cambia la caja de una nota; las de su pila la comparten, así que se mueven juntas. */
export function setNoteBox(board: Board, id: string, patch: Partial<Box>): Board {
  const note = board.notes[id];
  if (!note) return board;
  const box = { ...note.box, ...patch };
  const ids = note.stack ? stackMembers(board, note.stack) : [id];
  const notes = { ...board.notes };
  for (const m of ids) notes[m] = { ...notes[m], box };
  return { ...board, notes };
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
  // Antes de quitarla, que su pila siga bien (otra pasa al frente, o la pila se disuelve).
  board = leaveStack(board, id);
  const notes = { ...board.notes };
  delete notes[id];
  return { ...board, notes, edges: board.edges.filter((e) => e.a !== id && e.b !== id) };
}

// ── Portales ────────────────────────────────────────────────────────

export const PORTAL_SIZE = { w: 640, h: 440 };
/** Un teléfono es alto y angosto. */
export const PHONE_SIZE = { w: 320, h: 640 };
export const PHONE_MIN = { w: 240, h: 420 };
export const PORTAL_MIN = { w: 320, h: 240 };

function allBoxes(board: Board): Box[] {
  return [
    ...Object.values(board.nodes),
    ...Object.values(board.notes).map((n) => n.box),
    ...Object.values(board.portals).map((p) => p.box),
    ...Object.values(board.texts).map((t) => t.box),
    ...Object.values(board.images).map((i) => i.box),
    ...Object.values(board.folders).map((f) => f.box),
  ];
}

/** Un nombre de portal que nadie más usa en este canvas. */
export function uniquePortalName(board: Board, wanted: string, except?: string): string {
  const taken = new Set(
    Object.entries(board.portals).filter(([id]) => id !== except).map(([, p]) => p.name.toLowerCase()),
  );
  const base = wanted.trim() || "Portal";
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k++) {
    const candidate = `${base} ${k}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Agrega un portal; con `near`, a la derecha de ese nodo y conectado a él. */
export function addPortal(
  board: Board,
  portal: { id: string; name?: string; url?: string; near?: string; at?: { x: number; y: number }; kind?: "android"; avd?: string },
): { board: Board; name: string } {
  const android = portal.kind === "android";
  const size = android ? PHONE_SIZE : PORTAL_SIZE;
  const name = uniquePortalName(board, portal.name ?? (android ? "Android" : "Portal"));
  const others = allBoxes(board);
  const anchor = portal.near ? boxOf(board, portal.near) : undefined;
  let box: Box;
  if (anchor) {
    box = { x: anchor.x + anchor.w + GAP, y: anchor.y, ...size };
    for (let k = 1; k <= 50 && others.some((o) => overlaps(o, box)); k++) {
      box = { ...box, y: anchor.y + k * (size.h + GAP / 2) };
    }
  } else if (portal.at) {
    box = { x: Math.round(portal.at.x), y: Math.round(portal.at.y), ...size };
  } else {
    box = nextFreeBox(others, size);
  }
  const made: CanvasPortal = { name, url: portal.url ?? "", box, ...(android ? { kind: "android" as const, ...(portal.avd ? { avd: portal.avd } : {}) } : {}) };
  const next = { ...board, portals: { ...board.portals, [portal.id]: made } };
  return { board: anchor && portal.near ? addEdge(next, portal.near, portal.id) : next, name };
}

export function updatePortal(board: Board, id: string, patch: Partial<CanvasPortal>): Board {
  const portal = board.portals[id];
  if (!portal) return board;
  const named = patch.name !== undefined ? { ...patch, name: uniquePortalName(board, patch.name, id) } : patch;
  return { ...board, portals: { ...board.portals, [id]: { ...portal, ...named } } };
}

/** Quita un portal y sus conexiones. */
export function removePortal(board: Board, id: string): Board {
  if (!(id in board.portals)) return board;
  const portals = { ...board.portals };
  delete portals[id];
  return { ...board, portals, edges: board.edges.filter((e) => e.a !== id && e.b !== id) };
}

// ── Textos, imágenes y trazos ───────────────────────────────────────

export const TEXT_SIZES = [14, 20, 32, 48] as const;
export const TEXT_DEFAULT = { w: 240, h: 64, size: 20 };
export const IMAGE_MAX_SIDE = 420;

/** Un rótulo nuevo, en `at` (centro de lo que se ve). */
export function addText(board: Board, t: { id: string; at: { x: number; y: number }; text?: string; size?: number }): Board {
  const size = t.size ?? TEXT_DEFAULT.size;
  const box: Box = { x: Math.round(t.at.x), y: Math.round(t.at.y), w: TEXT_DEFAULT.w, h: Math.round(size * 2.6) };
  return { ...board, texts: { ...board.texts, [t.id]: { text: t.text ?? "", size, box } } };
}

export function updateText(board: Board, id: string, patch: Partial<CanvasText>): Board {
  const text = board.texts[id];
  return text ? { ...board, texts: { ...board.texts, [id]: { ...text, ...patch } } } : board;
}

export function removeText(board: Board, id: string): Board {
  if (!(id in board.texts)) return board;
  const texts = { ...board.texts };
  delete texts[id];
  return { ...board, texts };
}

/** Una imagen nueva con su proporción: la lado más largo, a `IMAGE_MAX_SIDE`. */
export function addImage(
  board: Board,
  img: { id: string; name: string; asset: string; width: number; height: number; at: { x: number; y: number } },
): Board {
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.width, img.height, 1));
  const w = Math.max(40, Math.round(img.width * scale));
  const h = Math.max(40, Math.round(img.height * scale));
  const box: Box = { x: Math.round(img.at.x - w / 2), y: Math.round(img.at.y - h / 2), w, h };
  return { ...board, images: { ...board.images, [img.id]: { name: img.name, asset: img.asset, box } } };
}

export function removeImage(board: Board, id: string): Board {
  if (!(id in board.images)) return board;
  const images = { ...board.images };
  delete images[id];
  return { ...board, images };
}

/** Los puntos de un trazo, sin los que casi no se mueven: una mano alzada deja cientos
 *  de puntos casi iguales que solo engordan el archivo. `minDist` en px del canvas. */
export function thin(points: number[], minDist: number): number[] {
  if (points.length <= 4) return points;
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - out[out.length - 2];
    const dy = points[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= minDist * minDist) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}

export function addStroke(board: Board, stroke: Stroke): Board {
  return stroke.points.length < 4 ? board : { ...board, drawings: [...board.drawings, stroke] };
}

export function removeStroke(board: Board, id: string): Board {
  const drawings = board.drawings.filter((s) => s.id !== id);
  return drawings.length === board.drawings.length ? board : { ...board, drawings };
}

/** Quita el último trazo (deshacer). */
export function undoStroke(board: Board): Board {
  return board.drawings.length === 0 ? board : { ...board, drawings: board.drawings.slice(0, -1) };
}

/** El camino SVG de un trazo, suavizado con curvas entre los puntos medios. */
export function strokePath(points: number[]): string {
  if (points.length < 4) return "";
  if (points.length === 4) return `M${points[0]} ${points[1]} L${points[2]} ${points[3]}`;
  let d = `M${points[0]} ${points[1]}`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const mx = (points[i] + points[i + 2]) / 2;
    const my = (points[i + 1] + points[i + 3]) / 2;
    d += ` Q${points[i]} ${points[i + 1]} ${mx} ${my}`;
  }
  d += ` L${points[points.length - 2]} ${points[points.length - 1]}`;
  return d;
}

// ── Carpetas ────────────────────────────────────────────────────────

/** Una carpeta nueva en `at` (la esquina de arriba a la izquierda). */
export function addFolder(board: Board, f: { id: string; path: string; name: string; at: { x: number; y: number } }): Board {
  const box: Box = { x: Math.round(f.at.x), y: Math.round(f.at.y), ...FOLDER_SIZE };
  return { ...board, folders: { ...board.folders, [f.id]: { path: f.path, name: f.name, open: [], box } } };
}

export function updateFolder(board: Board, id: string, patch: Partial<CanvasFolder>): Board {
  const folder = board.folders[id];
  return folder ? { ...board, folders: { ...board.folders, [id]: { ...folder, ...patch } } } : board;
}

export function removeFolder(board: Board, id: string): Board {
  if (!(id in board.folders)) return board;
  const folders = { ...board.folders };
  delete folders[id];
  return { ...board, folders };
}
