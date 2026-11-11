import type { ChatProjectIdentity } from "@/features/chat/chatProjectIdentity";
import { normalizeProjectPath } from "@/features/chat/chatProjectPrefs";

/**
 * O modelo da página Projetos, sem React: a lista de projetos (das conversas e dos rótulos guardados) e a
 * política de agentes por projeto. A página só desenha e chama o que está aqui.
 */

export interface ProjectRow {
  /** A pasta normalizada: a chave que a barra, a ordem e os rótulos usam. */
  readonly key: string;
  readonly cwd: string;
  /** O nome que aparece: o que a pessoa deu, ou o nome da pasta. */
  readonly name: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly icon: ChatProjectIdentity["icon"];
  /** Quantas conversas abertas há nele (0 quando só existe o rótulo guardado). */
  readonly conversations: number;
  /** Quando o último pedido seu chegou nele, no mesmo relógio que `openedAt` (a ordem só compara). */
  readonly latest: number;
}

/** O último pedoço do caminho: "/Users/ton/app" → "app". Pasta na raiz fica com o próprio caminho. */
export function basenameOf(cwd: string): string {
  const parts = normalizeProjectPath(cwd).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * As linhas da página: um projeto por pasta, com as conversas dele e os rótulos guardados. Um projeto só
 * com rótulo (fixado, arquivado ou renomeado) também entra, mesmo sem conversa aberta.
 */
export function buildProjectRows(input: {
  conversations: readonly { cwd: string; openedAt: number }[];
  identities: Readonly<Record<string, ChatProjectIdentity>>;
}): ProjectRow[] {
  const byKey = new Map<string, { cwd: string; latest: number; conversations: number }>();
  for (const conversation of input.conversations) {
    if (!conversation.cwd) continue;
    const key = normalizeProjectPath(conversation.cwd);
    const current = byKey.get(key) ?? { cwd: conversation.cwd, latest: 0, conversations: 0 };
    byKey.set(key, {
      cwd: current.cwd,
      latest: Math.max(current.latest, conversation.openedAt),
      conversations: current.conversations + 1,
    });
  }
  for (const [key, identity] of Object.entries(input.identities)) {
    if (!byKey.has(key) && (identity.known || identity.pinned || identity.archived)) {
      byKey.set(key, { cwd: key, latest: 0, conversations: 0 });
    }
  }
  return [...byKey.entries()].map(([key, value]) => {
    const identity = input.identities[key];
    return {
      key,
      cwd: value.cwd,
      name: identity?.name ?? basenameOf(value.cwd),
      pinned: identity?.pinned === true,
      archived: identity?.archived === true,
      icon: identity?.icon ?? null,
      conversations: value.conversations,
      latest: value.latest,
    };
  });
}

/**
 * Liga ou desliga um agente na lista de bloqueados do projeto. A lista sai ordenada e sem repetição, para a
 * comparação com o que está gravado dar sempre o mesmo resultado.
 */
export function withAgentEnabled(disabled: readonly string[], agentId: string, enabled: boolean): string[] {
  const next = new Set(disabled);
  if (enabled) next.delete(agentId);
  else next.add(agentId);
  return [...next].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** O texto que a página mostra como nome de um ícone (o monograma ou o emoji), ou `null` no automático. */
export function iconValueOf(icon: ChatProjectIdentity["icon"]): string | null {
  return icon ? icon.value : null;
}
