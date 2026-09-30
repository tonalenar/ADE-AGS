import type { Complexity } from "@/features/runs/types";

export interface FunctionalRole {
  id: string;
  label: string;
  description: string;
  instructions: string;
}

export interface SquadLead {
  agentId: string;
  model: string | null;
  accountId: string | null;
  accountName: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface SquadMember {
  roleId: string;
  agentId: string;
  model: string | null;
  accountId: string | null;
  accountName: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  isolateDefault: boolean;
  available: boolean;
  unavailableReason: string | null;
}

export interface Squad {
  id: string;
  name: string;
  description: string;
  lead: SquadLead;
  members: SquadMember[];
  createdAt: number;
  updatedAt: number;
  available: boolean;
  unavailableReasons: string[];
}

export interface SquadLeadInput {
  agentId: string;
  model: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
}

export interface SquadMemberInput {
  roleId: string;
  agentId: string;
  model: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  isolateDefault: boolean;
}

export interface SquadInput {
  name: string;
  description: string;
  lead: SquadLeadInput;
  members: SquadMemberInput[];
}

export interface RunSquadMember {
  roleId: string;
  agentId: string;
  model: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  isolateDefault: boolean;
}
