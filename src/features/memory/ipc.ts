import { invoke } from "@tauri-apps/api/core";
import type { MemoryContextMetrics, MemoryMissionContextMetrics } from "./contextMetrics";
import type { DeletedMemoryWorkspace, MemoryAgentDraft, MemoryExportResult, MemoryFilter, MemorySourceVerification, MemoryWorkspaceStats } from "./types";

import type { Fact } from "@/features/runs/types";
import type { MemoryDream, MemoryDetail, MemoryPage, MemoryReviewSummary, MemoryPendingCounts, MemoryProposal, MemoryProposalResult, MemoryScope, MemorySnapshot, MemoryValidityInterval, RepoSyncStatus } from "./types";

export const listMemory = (workspaceId: string, missionId: string | null, cursor?: string | null) =>
  invoke<MemoryPage>("memory_list", { workspaceId, missionId, cursor: cursor ?? null, limit: 32 });

export const queryMemory = (workspaceId: string, missionId: string | null, filter: MemoryFilter, cursor?: string | null) =>
  invoke<MemoryPage>("memory_query", { workspaceId, missionId, filter, cursor: cursor ?? null, limit: 32 });

export const getRunMemoryContextMetrics = (runId: string) =>
  invoke<MemoryContextMetrics>("memory_context_metrics", { runId, missionId: null });

export const getMissionMemoryContextMetrics = (missionId: string) =>
  invoke<MemoryMissionContextMetrics>("memory_context_metrics", { runId: null, missionId });

export const exportMemory = (workspaceId: string) =>
  invoke<MemoryExportResult>("memory_export", { workspaceId });

export const getMemoryWorkspaceStats = (workspaceId: string) =>
  invoke<MemoryWorkspaceStats>("memory_workspace_stats", { workspaceId });

export const listMemoryAgentDrafts = (workspaceId: string) =>
  invoke<MemoryAgentDraft[]>("memory_agent_drafts", { workspaceId });

export const promoteMemoryAgentDraft = (workspaceId: string, draftId: string) =>
  invoke<MemoryProposalResult>("memory_promote_draft", { workspaceId, draftId });

export const discardMemoryAgentDraft = (workspaceId: string, draftId: string) =>
  invoke<void>("memory_discard_draft", { workspaceId, draftId });

export const verifyMemorySource = (entryId: string, filePath?: string | null, commit?: string | null) =>
  invoke<MemorySourceVerification>("memory_verify_source", { entryId, filePath: filePath ?? null, commit: commit ?? null });

export const listDeletedMemoryWorkspaces = () =>
  invoke<DeletedMemoryWorkspace[]>("workspace_deleted_list");

export const restoreMemoryWorkspace = (workspaceId: string) =>
  invoke<void>("workspace_restore", { workspaceId });

export const getPendingCounts = (workspaceId: string) =>
  invoke<MemoryPendingCounts>("memory_pending_counts", { workspaceId });

export const getMemory = (entryId: string, workspaceId: string, missionId: string | null) =>
  invoke<MemoryDetail>("memory_get", { entryId, workspaceId, missionId });

export const getMemoryHistory = (entryId: string, workspaceId: string, missionId: string | null) =>
  invoke<MemoryValidityInterval[]>("memory_history", { entryId, workspaceId, missionId });

export const proposeMemory = (workspaceId: string, missionId: string | null, input: MemoryProposal) =>
  invoke<MemoryProposalResult>("memory_propose_user", { workspaceId, missionId, input });

export const decideMemory = (entryId: string, revision: number, approve: boolean, acknowledgeSecret = false) =>
  invoke<void>("memory_decide_user", { entryId, revision, approve, acknowledgeSecret });

export const getRepoSyncStatus = (workspaceId: string) =>
  invoke<RepoSyncStatus>("memory_repo_sync_status", { workspaceId });

export const retryRepoSync = (workspaceId: string) =>
  invoke<RepoSyncStatus>("memory_repo_sync_retry", { workspaceId });

export const promoteFact = (runId: string, factId: string, scope: MemoryScope, key: string, priority: number, reason?: string) =>
  invoke<MemoryProposalResult>("memory_promote_fact_user", { runId, factId, scope, key, priority, reason: reason ?? null });

export const listMemorySnapshot = (runId: string) =>
  invoke<MemorySnapshot>("run_list_memory_snapshot", { runId });

export const listRunFacts = (runId: string) => invoke<Fact[]>("run_list_facts", { runId });

export const getMemoryReviewSummary = (missionId: string) =>
  invoke<MemoryReviewSummary>("memory_review_summary", { missionId });

export const getWorkspaceReviewSummary = (workspaceId: string) =>
  invoke<unknown>("memory_review_summary_workspace", { workspaceId });

// PROVISÓRIO: contratos da Etapa 23 ainda sendo fechados com o Backend.
export const purgeMemoryUser = (entryId: string, revision: number | null) =>
  invoke<void>("memory_purge_user", { entryId, revision });

export const startDream = (workspaceId: string) =>
  invoke<{ dreamId: string; runId: string }>("memory_dream_start", { workspaceId });

export const listDreams = (workspaceId: string) =>
  invoke<MemoryDream[]>("memory_dreams_workspace", { workspaceId });
