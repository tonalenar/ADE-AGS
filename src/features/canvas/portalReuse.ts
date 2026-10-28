/**
 * Reaproveitar um navegador do canvas em vez de abrir outro. Quando a aba de um agente fecha, o navegador que ela usava fica
 * no canvas sem dono: a aba seguinte não o alcança (só os conectados a ela) e abria um novo a cada vez — numa rodada de
 * testes, um navegador por rodada. Aqui se escolhe o que sobrou para quem está pedindo um.
 */
import type { Board } from "./board";

function originOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/**
 * O navegador do canvas sem dono (nenhuma aba aberta conectada a ele) que serve a quem pede: o que já está na mesma origem do
 * endereço pedido, senão o mais recente. Nunca a tela de um Android. `null` = nenhum. Pura.
 */
export function orphanPortal(board: Pick<Board, "portals" | "edges">, openTabs: ReadonlySet<string>, url?: string): string | null {
  const owned = new Set<string>();
  for (const edge of board.edges) {
    if (openTabs.has(edge.a)) owned.add(edge.b);
    if (openTabs.has(edge.b)) owned.add(edge.a);
  }
  const orphans = Object.entries(board.portals).filter(([id, portal]) => portal.kind !== "android" && !owned.has(id)).map(([id]) => id);
  if (orphans.length === 0) return null;
  const wanted = originOf(url);
  const sameOrigin = wanted ? orphans.filter((id) => originOf(board.portals[id].url) === wanted) : [];
  const pool = sameOrigin.length > 0 ? sameOrigin : orphans;
  return pool[pool.length - 1] ?? null;
}
