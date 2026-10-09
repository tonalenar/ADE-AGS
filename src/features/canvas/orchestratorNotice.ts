/**
 * Avisa um orquestrador do canvas de quem está conectado a ele.
 *
 * O canvas já deixa o orquestrador falar com os terminais ligados por corda (`ags peers`,
 * `ags peer ask|tell`), mas o agente não sabe disso se ninguém contar: ele continua
 * trabalhando sozinho. Quando a pessoa marca um terminal como orquestrador, ou liga uma corda
 * a um orquestrador, ele recebe uma mensagem curta dizendo quem são os outros e como usá-los.
 */
import type { Board } from "./board";

interface NamedTab { id: string; title: string; agentLabel: string }

/** Quem está ligado por corda ao orquestrador `orchestratorId`, sem repetir. */
export function linkedPeers(board: Board, orchestratorId: string): string[] {
  const ids = board.edges.flatMap((edge) =>
    edge.a === orchestratorId ? [edge.b] : edge.b === orchestratorId ? [edge.a] : []);
  return [...new Set(ids)].filter((id) => id in board.nodes);
}

/** O texto do aviso, ou `null` se o terminal não é orquestrador ou não tem ninguém ligado. */
export function orchestratorNotice(board: Board, tabs: NamedTab[], orchestratorId: string): string | null {
  if (!board.orchestrators.includes(orchestratorId)) return null;
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const peers = linkedPeers(board, orchestratorId)
    .map((id) => byId.get(id))
    .filter((tab): tab is NamedTab => !!tab);
  if (peers.length === 0) return null;
  const names = peers.map((tab) => `${tab.title.split(" — ")[0]} (${tab.agentLabel})`).join(", ");
  return `[ADE AGS] Você é o orquestrador deste canvas e tem ${peers.length === 1 ? "um terminal conectado" : `${peers.length} terminais conectados`} a você: ${names}. `
    + "Rode `ags peers` para ver os nomes exatos. Use `ags peer ask <nome> \"...\"` para pedir algo e esperar a resposta, "
    + "`ags peer tell <nome> \"...\"` para avisar sem esperar e `ags tab output <id>` para ler a tela deles. "
    + "Delegue o trabalho a eles em vez de fazer tudo sozinho.";
}

/** O que já foi dito a cada orquestrador (a lista de ligados), para não repetir o mesmo aviso. */
const told = new Map<string, string>();

/** Esquece o que foi dito; a próxima ligação volta a avisar. Usado ao desmarcar o orquestrador. */
export function forgetOrchestrator(orchestratorId: string): void {
  told.delete(orchestratorId);
}

/** `true` se há um aviso novo para este orquestrador (a lista de ligados mudou desde o último). */
export function shouldAnnounce(board: Board, orchestratorId: string): boolean {
  if (!board.orchestrators.includes(orchestratorId)) return false;
  const signature = linkedPeers(board, orchestratorId).sort().join("|");
  if (!signature || told.get(orchestratorId) === signature) return false;
  told.set(orchestratorId, signature);
  return true;
}
