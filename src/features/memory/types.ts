import type { Fact, Run } from "@/features/runs/types";

export type MemoryScope = "workspace" | "mission";
export type MemoryKind = "decision" | "finding" | "file" | "constraint" | "note";
export type MemoryOperation = "create" | "update" | "delete";

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
