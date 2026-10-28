/** Espelha `src-tauri/src/tab_checkpoints/store.rs` (`TabCheckpoint`). */
export interface TabCheckpoint {
  id: string;
  tabId: string;
  seq: number;
  kind: "message" | "manual" | "safety" | string;
  /** `pessoa`, `ade`, `ags`, `peer`, `chat`, `rotina`… */
  author: string;
  message: string;
  repoRoot: string;
  refName: string;
  commitSha: string;
  treeSha: string;
  headSha: string | null;
  /** Milissegundos. */
  createdAt: number;
}

/** `service::Capture`. */
export type CaptureResult =
  | { status: "created"; checkpoint: TabCheckpoint }
  | { status: "unchanged"; checkpoint: TabCheckpoint }
  | { status: "notRepo" };

export interface CheckpointDiff {
  stat: string;
  patch: string;
  truncated: boolean;
}

export interface Blocker {
  kind: "tab" | "task" | string;
  id: string;
  dir: string;
}

export interface RestoreReport {
  written: number;
  deleted: number;
  failed: string[];
}

/** `service::Restore`. Com `blockers` e sem `safety`, nada foi feito. */
export interface RestoreResult {
  blockers: Blocker[];
  safety: TabCheckpoint | null;
  report: RestoreReport | null;
}
