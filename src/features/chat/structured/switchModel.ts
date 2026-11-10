import type { AgentInfo } from "@/features/tabs/types";

import { isStructuredAgent } from "./model";
import type { HarnessSupport } from "../harnessCapabilities";

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
 * A matriz marca se o provider tem um caminho de aprovação; ACP local conserva a política de acesso própria.
 * A confirmação da troca avisa quando a conversa está em Supervisionado. Pura.
 */
export function lacksApproval(support: HarnessSupport, access: string, localAcp = false): boolean {
  return (support === "unsupported" || localAcp) && access === "ask";
}
