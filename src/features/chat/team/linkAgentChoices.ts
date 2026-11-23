import type { AgentAccount } from "@/features/accounts/types";
import type { Roster } from "@/features/runs/types";
import type { AgentInfo } from "@/features/tabs/types";

import { buildRail } from "../pickerRail";

/** Uma linha do campo "Agente" do «Ligar ao time»: um agente numa conta (`null` = a principal). */
export interface AgentChoice {
  key: string;
  agent: AgentInfo;
  accountId: string | null;
  /** "Antigravity" ou "Antigravity · alencaar4": o mesmo nome do trilho do seletor de modelo. */
  name: string;
  loggedIn: boolean;
}

/**
 * As escolhas de agente + conta, as mesmas do trilho do seletor de modelo do chat: a principal e todas as contas
 * extras de cada agente, inclusive as sem login (o rótulo avisa). Sem roster ainda, uma por agente. Pura.
 */
export function agentChoices(agents: readonly AgentInfo[], roster: Roster | null, identities: readonly AgentAccount[], principalLabel: string): AgentChoice[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return buildRail(agents, roster?.agents ? roster : null, identities, principalLabel, true).flatMap((item) => {
    const agent = byId.get(item.agentId);
    return agent ? [{ key: item.key, agent, accountId: item.accountId, name: item.name, loggedIn: item.loggedIn }] : [];
  });
}
