import { agentDef } from "@/features/agents/registry";

import type { AgentInfo } from "./types";

/** Flags do catálogo estático. `detect_agents` chega tarde; a tab restaurada não. */
function catalogLaunchArgs(agentId: string | undefined): string[] {
  if (!agentId) return [];
  return agentDef(agentId)?.launchArgs ?? [];
}

/**
 * O comando efetivo do terminal: binário + flags de lançamento da TUI.
 *
 * Não repete uma flag que o comando já traz (duplicar uma tab, retomar uma sessão
 * ou reabrir um workspace já gravado com a flag). Se `launchArgs` não vier no
 * agente — resume e duplicação reconstroem o `AgentInfo` só com o comando salvo —
 * usa o catálogo estático, carregado antes do primeiro render.
 */
export function buildLaunchCommand(
  agent: Pick<AgentInfo, "command" | "launchArgs"> & { id?: string },
): string {
  const args = agent.launchArgs ?? catalogLaunchArgs(agent.id);
  const present = new Set(agent.command.split(/\s+/).filter(Boolean));
  const missing = args.filter((arg) => arg.length > 0 && !present.has(arg));
  return [agent.command.trim(), ...missing].filter((part) => part.length > 0).join(" ");
}
