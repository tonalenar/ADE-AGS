import type { AgentInfo } from "@/features/tabs/types";

import { isLocalAcpAgent, isStructuredAgent } from "./model";

/**
 * Os agentes que a conversa pode assumir: os que conversam por protocolo e estão instalados, com o da conversa
 * primeiro (ele nunca some da lista, mesmo que a detecção ainda não tenha chegado). Pura.
 */
export function switchableAgents(detected: AgentInfo[], currentId: string, currentLabel = currentId): AgentInfo[] {
  const usable = detected.filter((a) => a.available && isStructuredAgent(a.id));
  const current = usable.find((a) => a.id === currentId) ?? detected.find((a) => a.id === currentId)
    ?? ({ id: currentId, label: currentLabel, command: "", available: true } as AgentInfo);
  return [current, ...usable.filter((a) => a.id !== currentId)];
}

/**
 * O agente novo não tem tela de aprovação (o Antigravity e o Cursor por `-p` não perguntam) e a conversa está em Supervisionado:
 * o que pediria aprovação é negado. A confirmação da troca avisa antes. Pura.
 */
export function lacksApproval(agentId: string, access: string): boolean {
  return (agentId === "antigravity" || agentId === "cursor" || isLocalAcpAgent(agentId)) && access === "ask";
}
