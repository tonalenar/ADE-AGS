/** Os tipos da comparação de modelos, espelho de `src-tauri/src/compare/{model,git,commands}.rs`. */

export interface CompareEntry {
  pick: string;
  label: string;
  agentId: string;
  cwd: string;
  /** `null` = sem isolamento (todos na mesma pasta). */
  root: string | null;
  branch: string | null;
  tabId: string | null;
}

export interface Comparison {
  id: string;
  title: string;
  slug: string;
  cwd: string;
  repo: string | null;
  base: string | null;
  isolated: boolean;
  createdAt: number;
  kept: string | null;
  entries: CompareEntry[];
}

export interface CompareSetup {
  pick: string;
  prelaunch: string | null;
  environment: string;
}

export interface PreparedComparison {
  comparison: Comparison;
  setups: CompareSetup[];
}

export interface RepoCheck {
  repo: string | null;
  branch: string | null;
  head: string | null;
  dirty: number;
  error: string | null;
}

export interface EntryStatus {
  pick: string;
  files: number;
  insertions: number;
  deletions: number;
  untracked: number;
  commits: number;
  dirty: boolean;
  error: string | null;
}

export interface DiffView {
  pick: string;
  branch: string | null;
  base: string;
  stat: string;
  patch: string;
  untracked: string[];
  truncated: boolean;
}

export interface RemoveEntry {
  pick: string;
  removed: boolean;
  blockers: string[];
  dirty: string[];
  commits: string[];
  savedRef: string | null;
  branchKept: boolean;
  needsConfirmation: boolean;
}

export interface RemoveReport {
  dryRun: boolean;
  entries: RemoveEntry[];
  closed: boolean;
}

export interface FinishReport {
  pick: string;
  branch: string | null;
  removed: boolean;
  committed: boolean;
  blockers: string[];
  dirty: string[];
  needsCommit: boolean;
}

/** Uma escolha do diálogo, antes de virar nome de branch. */
export interface PickDraft {
  agentId: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
}
