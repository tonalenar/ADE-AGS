import { GAP, nextFreeBox, type Box, type Viewport } from "./geometry";

/** Una conexión entre dos terminales. Sin sentido: los dos lados pueden hablarse. */
export interface CanvasEdge {
  id: string;
  a: string;
  b: string;
}

/** El canvas de un proyecto. Las claves de `nodes` son ids de tab. */
export interface Board {
  nodes: Record<string, Box>;
  edges: CanvasEdge[];
  viewport: Viewport;
  /** Las orquestadoras: alcanzan a todo su equipo y pueden sumar agentes y conectarlos. */
  orchestrators: string[];
}

export function emptyBoard(): Board {
  return { nodes: {}, edges: [], viewport: { x: 40, y: 40, zoom: 1 }, orchestrators: [] };
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
  const edges = board.edges.filter((e) => open.has(e.a) && open.has(e.b));
  const orchestrators = board.orchestrators.filter((id) => open.has(id));

  if (
    missing.length === 0 && kept.length === Object.keys(board.nodes).length &&
    edges.length === board.edges.length && orchestrators.length === board.orchestrators.length
  ) {
    return board;
  }

  const nodes: Record<string, Box> = Object.fromEntries(kept);
  for (const id of missing) nodes[id] = nextFreeBox(Object.values(nodes));
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
