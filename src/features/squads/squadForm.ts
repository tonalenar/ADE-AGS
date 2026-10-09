import type { FunctionalRole, Squad, SquadInput, SquadMemberInput } from "./types";

export const EMPTY_SQUAD_INPUT: SquadInput = {
  name: "",
  description: "",
  lead: { agentId: "", model: null, accountId: null, autoAccount: true, complexity: null },
  members: [],
  defaultSubagent: null,
};

export function inputFromSquad(squad: Squad): SquadInput {
  return {
    name: squad.name,
    description: squad.description,
    lead: {
      agentId: squad.lead.agentId,
      model: squad.lead.model,
      reasoningEffort: squad.lead.reasoningEffort ?? null,
      accountId: squad.lead.accountId,
      autoAccount: squad.lead.autoAccount,
      complexity: squad.lead.complexity,
      fastMode: squad.lead.fastMode === true,
    },
    defaultSubagent: squad.defaultSubagent
      ? { ...squad.defaultSubagent, reasoningEffort: squad.defaultSubagent.reasoningEffort ?? null, fastMode: squad.defaultSubagent.fastMode === true }
      : null,
    members: squad.members.map((member) => ({
      roleId: member.roleId,
      agentId: member.agentId,
      model: member.model,
      reasoningEffort: member.reasoningEffort ?? null,
      accountId: member.accountId,
      autoAccount: member.autoAccount,
      complexity: member.complexity,
      fastMode: member.fastMode === true,
      isolateDefault: member.isolateDefault,
    })),
  };
}

export function availableSquadRoles(roles: FunctionalRole[], members: SquadMemberInput[]): FunctionalRole[] {
  const configured = new Set(members.map((member) => member.roleId));
  return roles.filter((role) => !configured.has(role.id));
}

export function addSquadRole(input: SquadInput, roleId: string): SquadInput {
  if (!roleId || input.members.some((member) => member.roleId === roleId)) return input;
  return {
    ...input,
    members: [...input.members, {
      roleId,
      agentId: "",
      model: null,
      accountId: null,
      autoAccount: true,
      complexity: null,
      isolateDefault: true,
    }],
  };
}

export function removeSquadRole(input: SquadInput, roleId: string): SquadInput {
  return { ...input, members: input.members.filter((member) => member.roleId !== roleId) };
}

/** O subagente padrão está completo para salvar: Automático, ou um agente (com modelo quando o modo é específico). */
export function subagentDefaultIsReady(value: SquadInput["defaultSubagent"]): boolean {
  // `model: ""` é "modelo específico" escolhido e deixado em branco; `null` é o padrão do provedor.
  return !value || (Boolean(value.agentId.trim()) && value.model !== "");
}
