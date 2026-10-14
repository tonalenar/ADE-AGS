import { SHELL_AGENT_ID } from "@/features/tabs/types";

/** Chave do último agente aberto neste app (um só, não por workspace). */
export const LAST_AGENT_KEY = "ade-last-agent";

/** Lê o agente usado por último. Sem localStorage disponível, volta `null`. */
export function loadLastAgent(): string | null {
  try {
    return localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

/**
 * Lembra o agente que acabou de abrir. A terminal pelada não conta: ela não é um agente,
 * e lembrá-la faria o "de sempre" ser um bash sem skills.
 */
export function rememberLastAgent(id: string): void {
  if (!id || id === SHELL_AGENT_ID) return;
  try {
    localStorage.setItem(LAST_AGENT_KEY, id);
  } catch {
    // Sem armazenamento, o atalho simplesmente não aparece: não é motivo para travar a abertura.
  }
}

/** Leva o `lastId` para a frente, se ele estiver na lista. O resto segue na mesma ordem. */
export function orderAgents<T extends { id: string }>(agents: T[], lastId: string | null): T[] {
  if (!lastId) return [...agents];
  const last = agents.find((a) => a.id === lastId);
  if (!last) return [...agents];
  return [last, ...agents.filter((a) => a.id !== lastId)];
}
