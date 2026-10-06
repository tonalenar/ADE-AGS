/** Contrato de la limpieza de worktrees/ramas de una misión (`mission_cleanup`, Etapa 21, ítem 7a). */
import { invoke } from "@tauri-apps/api/core";

export interface CleanupEntry {
  missionId: string | null;
  root: string;
  branch: string;
  sizeBytes: number;
  /** Qué impide limpiar (archivos sin commit, commits fuera de master, pestañas abiertas...), en texto. */
  blockers: string[];
  removed: boolean;
}

export interface CleanupReport {
  dryRun: boolean;
  entries: CleanupEntry[];
}

/** Por defecto simula (`dryRun = true`): nada se borra sin pedirlo expresamente. */
export const missionCleanup = (missionId: string, dryRun = true) =>
  invoke<CleanupReport>("mission_cleanup", { missionId, dryRun });

/** Todos los bloqueos de la misión: uno solo en cualquier entrada impide limpiar todo. Pura. */
export const cleanupBlockers = (r: CleanupReport): string[] => r.entries.flatMap((e) => e.blockers);

/** Solo se ofrece confirmar si hay algo que limpiar y ningún bloqueo. Pura. */
export const canConfirmCleanup = (r: CleanupReport): boolean => r.dryRun && r.entries.length > 0 && cleanupBlockers(r).length === 0;

export const totalBytes = (r: CleanupReport): number => r.entries.reduce((n, e) => n + e.sizeBytes, 0);

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
