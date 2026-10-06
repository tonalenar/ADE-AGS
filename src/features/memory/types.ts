import type { Fact, Run } from "@/features/runs/types";

export type MemoryScope = "workspace" | "mission";
export type MemoryKind = "decision" | "finding" | "file" | "constraint" | "note";
export type MemoryOperation = "create" | "update" | "delete";

export interface MemoryPendingCounts {
  workspace: number;
  byMission: Record<string, number>;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  workspaceId: string;
  missionId: string | null;
  key: string;
  kind: MemoryKind;
  status: "active" | "inactive" | "deleted";
  currentRevision: number | null;
  priority: number;
  body: string | null;
  bodyTruncated?: boolean;
  pendingBodyTruncated?: boolean;
  authorKind: "user" | "lead" | "worker" | null;
  sourceRunId: string | null;
  sourceTaskId: string | null;
  sourceFactId: string | null;
  createdAt: number;
  updatedAt: number;
  pendingRevision: number | null;
  pendingOperation: MemoryOperation | null;
  pendingKind: MemoryKind | null;
  pendingPriority: number | null;
  pendingBody: string | null;
  pendingActorKind: "user" | "lead" | "worker" | null;
  pendingSourceRunId: string | null;
  pendingSourceTaskId: string | null;
  pendingSourceFactId: string | null;
  pendingReason: string | null;
  pendingCreatedAt: number | null;
}

export interface MemoryRevision {
  entryId: string;
  revision: number;
  status: "proposed" | "approved" | "rejected";
  operation: MemoryOperation;
  kind: MemoryKind;
  priority: number;
  body: string;
  contentHash: string;
  actorKind: "user" | "lead" | "worker";
  sourceRunId: string | null;
  sourceTaskId: string | null;
  sourceFactId: string | null;
  reason: string | null;
  expectedRevision: number | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface MemoryDetail {
  entry: MemoryEntry;
  revisions: MemoryRevision[];
}

export interface MemoryValidityInterval {
  revision: number;
  operation: "create" | "update";
  kind: MemoryKind;
  priority: number;
  body: string;
  actorKind: "user" | "lead" | "worker";
  reason: string | null;
  validFrom: number;
  validTo: number | null;
}

export interface MemoryPage {
  items: MemoryEntry[];
  hasMore: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

export interface MemorySnapshotItem {
  runId: string;
  entryId: string;
  revision: number;
  scope: MemoryScope;
  key: string;
  kind: MemoryKind;
  body: string;
  priority: number;
  contentHash: string;
  selectionOrder: number;
  truncated: boolean;
}

export interface MemorySnapshot {
  items: MemorySnapshotItem[];
  meta: { omittedEntries: number; truncatedEntries: number; contextBytes: number };
}

export interface MemoryProposal {
  scope: MemoryScope;
  key: string;
  kind: MemoryKind;
  body: string;
  priority: number;
  operation: MemoryOperation;
  expectedRevision: number | null;
  reason?: string | null;
}

export interface MemoryProposalResult {
  entryId: string;
  revision: number;
  status: string;
  idempotent: boolean;
}

export type MemoryRun = Run;
export type MemoryFact = Fact;

export interface MemoryReviewEvidence {
  runId: string | null;
  taskId: string | null;
  factId: string | null;
  actorKind: "user" | "lead" | "worker";
  reason: string | null;
}

export interface MemoryReviewRef {
  entryId: string;
  key: string;
}

/** Sugestão pendente + classificação feita no backend (duplicada/contraditória com as aprovadas, valor). */
export interface MemoryReviewItem {
  entryId: string;
  revision: number;
  key: string;
  kind: MemoryKind;
  body: string;
  priority: number;
  evidence: MemoryReviewEvidence;
  duplicateOf?: MemoryReviewRef | null;
  contradicts?: MemoryReviewRef | null;
  /** Solo lo manda `memory_review_summary_workspace`; ausente = create/update. */
  operation?: MemoryOperation;
  highValue: boolean;
  /** 0-100; highValue = score >= 70. */
  score: number;
}

export interface MemoryReviewSummary {
  missionId: string;
  items: MemoryReviewItem[];
  counts: { total: number; duplicates: number; contradictions: number; highValue: number };
}

export interface MemoryReviewCounts { total: number; duplicates: number; contradictions: number; highValue: number }

/** Todas las pendientes del workspace por misión; `missionId: null` = propuestas del workspace sin misión. */
export interface MemoryWorkspaceReview {
  workspaceId: string;
  groups: { missionId: string | null; missionTitle: string | null; items: MemoryReviewItem[]; counts: MemoryReviewCounts }[];
  counts: MemoryReviewCounts;
}
