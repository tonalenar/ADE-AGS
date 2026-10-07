import type { Fact, Run } from "@/features/runs/types";

export type MemoryActorKind = "user" | "lead" | "worker" | "dreamer";

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
  authorKind: MemoryActorKind | null;
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
  pendingActorKind: MemoryActorKind | null;
  pendingSourceRunId: string | null;
  pendingSourceTaskId: string | null;
  pendingSourceFactId: string | null;
  pendingReason: string | null;
  pendingCreatedAt: number | null;
  sourceFactId?: string | null;
  lastVerified?: number | null;
  ttlDays?: number | null;
  timesUsed?: number;
}

/** Optional filters; omit/null keeps the existing query behavior. */
export interface MemoryFilter {
  query?: string | null;
  kind?: MemoryKind | null;
  status?: "active" | "inactive" | "deleted" | "pending" | "approved" | "rejected" | null;
  used?: boolean | null;
  duplicateOf?: boolean | null;
  contradicts?: boolean | null;
  verificationExpired?: boolean | null;
}

export interface MemoryUsage {
  timesUsed: number;
  entriesUsed: number;
  runsUsingMemory: number;
  method: "selected_in_run_snapshot";
}

export interface MemoryWorkspaceStats {
  entries: number;
  revisions: number;
  deletedAt: number | null;
  deleteAfter: number | null;
  memoryUsage: MemoryUsage;
}

export interface MemoryExportResult extends MemoryWorkspaceStats { path: string }

export interface MemoryAgentDraft {
  id: string;
  scope: MemoryScope;
  missionId: string | null;
  /** Serialized JSON proposal; render parsed values as untrusted text. */
  proposal: string;
  actorKind: MemoryActorKind;
  createdAt: number;
  status: "agent_draft";
}

export interface MemorySourceVerification {
  runExists: boolean | null;
  taskExists: boolean | null;
  fileExists: boolean | null;
  commitExists: boolean | null;
  lastVerifiedChanged: false;
}

export interface DeletedMemoryWorkspace {
  id: string;
  name: string;
  deletedAt: number;
  deleteAfter: number | null;
  remainingSeconds: number | null;
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
  actorKind: MemoryActorKind;
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
  actorKind: MemoryActorKind;
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
  actorKind: MemoryActorKind;
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

/** PROVISÓRIO (contrato proposto ao Backend, Etapa 23): um "sonho" do Dreamer com suas propostas e o diff Markdown. */
export interface MemoryDream {
  dreamId: string;
  runId: string;
  createdAt: number;
  status: "running" | "done" | "failed";
  proposals: MemoryReviewItem[];
  /** Diff unificado da projeção Markdown, calculado pelo ADE (nunca pelo agente). */
  markdownDiff: string;
  questions: string[];
}
