/** Sincronização opcional de memórias para repositório GitHub privado (`src-tauri/src/memory_sync/`). */

export interface SkippedMemoryPage {
  source: "ai-memory" | "sqlite" | string;
  path: string;
  title: string;
  reason: string;
}

export interface MemorySyncReport {
  at: number;
  pushed: boolean;
  commit: string | null;
  aiMemoryPages: number;
  sqliteEntries: number;
  sqliteRevisions: number;
  skippedPages: SkippedMemoryPage[];
  aiMemoryNote: string | null;
}

export interface MemorySyncStatus {
  enabled: boolean;
  configured: boolean;
  accountId: string | null;
  repo: string | null;
  webUrl: string | null;
  autoEnabled: boolean;
  intervalHours: number;
  last: MemorySyncReport | null;
  lastError: string | null;
}

export interface MemorySyncResult {
  status: MemorySyncStatus;
  report: MemorySyncReport;
}
