/** Sincronização opcional de memórias para repositório GitHub privado (`src-tauri/src/memory_sync/`). */

export interface SkippedMemoryPage {
  source: "ai-memory" | "sqlite" | string;
  path: string;
  title: string;
  reason: string;
}

/** Resultado da leitura do ai-memory no envio: `ok`, sem páginas (`empty`) ou sem resposta (`unavailable`). */
export type AiMemoryReadStatus = "ok" | "empty" | "unavailable";

export interface MemorySyncReport {
  at: number;
  restored: boolean;
  pushed: boolean;
  commit: string | null;
  aiMemoryPages: number;
  sqliteEntries: number;
  sqliteRevisions: number;
  skippedPages: SkippedMemoryPage[];
  aiMemoryNote: string | null;
  aiMemoryStatus?: AiMemoryReadStatus;
  restore: MemoryRestoreReport;
}

export interface MemoryRestoreConflict {
  workspace?: string;
  project?: string;
  path: string;
  remotePath: string;
  title: string;
  localBody: string;
  remoteBody: string;
}

export interface MemoryRestoreReport {
  imported: number;
  unchanged: number;
  conflicts: MemoryRestoreConflict[];
  skippedSecrets: number;
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

/** Aviso a mostrar no lugar de "sucesso": nada foi lido do ai-memory, ou nada havia para enviar. */
export function memorySyncWarning(report: MemorySyncReport): "unavailable" | "empty" | null {
  if (report.restored) return null;
  if (report.aiMemoryStatus === "unavailable") return "unavailable";
  if (report.aiMemoryStatus === "empty" && report.sqliteEntries === 0) return "empty";
  return null;
}
