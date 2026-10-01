import { invoke } from "@tauri-apps/api/core";

import type { Fact } from "@/features/runs/types";
import type { MemoryDetail, MemoryPage, MemoryProposal, MemoryProposalResult, MemoryScope, MemorySnapshot } from "./types";

export const listMemory = (workspaceId: string, missionId: string | null, cursor?: string | null) =>
  invoke<MemoryPage>("memory_list", { workspaceId, missionId, cursor: cursor ?? null, limit: 32 });

export const getMemory = (entryId: string, workspaceId: string, missionId: string | null) =>
  invoke<MemoryDetail>("memory_get", { entryId, workspaceId, missionId });

export const proposeMemory = (workspaceId: string, missionId: string | null, input: MemoryProposal) =>
  invoke<MemoryProposalResult>("memory_propose_user", { workspaceId, missionId, input });

export const decideMemory = (entryId: string, revision: number, approve: boolean) =>
  invoke<void>("memory_decide_user", { entryId, revision, approve });

export const promoteFact = (runId: string, factId: string, scope: MemoryScope, key: string, priority: number, reason?: string) =>
  invoke<MemoryProposalResult>("memory_promote_fact_user", { runId, factId, scope, key, priority, reason: reason ?? null });

export const listMemorySnapshot = (runId: string) =>
  invoke<MemorySnapshot>("run_list_memory_snapshot", { runId });

export const listRunFacts = (runId: string) => invoke<Fact[]>("run_list_facts", { runId });
