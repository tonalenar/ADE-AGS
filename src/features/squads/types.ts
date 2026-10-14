import type { Complexity } from "@/features/runs/types";

export interface FunctionalRole {
  id: string;
  label: string;
  description: string;
  instructions: string;
}

export type AssignmentAvailability =
  | "available"
  | "unknown"
  | "provider_missing"
  | "provider_not_installed"
  | "provider_not_headless"
  | "provider_not_orchestrating"
  | "account_missing"
  | "account_provider_mismatch";

export function assignmentIsUnavailable(availability: AssignmentAvailability): boolean {
  return availability !== "available" && availability !== "unknown";
}

export interface SquadLead {
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  fastMode?: boolean;
  availability: AssignmentAvailability;
  unavailableReason: string | null;
}

export interface SquadMember {
  roleId: string;
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  fastMode?: boolean;
  isolateDefault: boolean;
  availability: AssignmentAvailability;
  unavailableReason: string | null;
}

/**
 * Um subagente do Squad: quantos a pessoa quiser, inclusive com a mesma função repetida.
 * `roleId: null` = sem especificação: o orquestrador decide o que ele é (`ags peer role`).
 */
export interface SquadExtraMember extends Omit<SquadMember, "roleId"> {
  roleId: string | null;
}

/** O LLM padrão dos subagentes recrutados. Ausente/`null` = Automático (a orquestradora decide). */
export interface SubagentDefault {
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean;
}

export interface Squad {
  id: string;
  name: string;
  description: string;
  lead: SquadLead;
  members: SquadMember[];
  /** Os subagentes extras (ilimitados). Squads antigos não têm. */
  extraMembers?: SquadExtraMember[];
  defaultSubagent?: SubagentDefault | null;
  createdAt: number;
  updatedAt: number;
  available: boolean;
  unavailableReasons: string[];
}

export interface SquadLeadInput {
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  fastMode?: boolean;
}

export interface SquadMemberInput {
  roleId: string;
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  fastMode?: boolean;
  isolateDefault: boolean;
}

export interface SquadExtraMemberInput extends Omit<SquadMemberInput, "roleId"> {
  roleId: string | null;
}

export interface SquadInput {
  name: string;
  description: string;
  lead: SquadLeadInput;
  members: SquadMemberInput[];
  extraMembers?: SquadExtraMemberInput[];
  defaultSubagent?: SubagentDefault | null;
}

export interface RunSquadMember {
  roleId: string;
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  isolateDefault: boolean;
}
