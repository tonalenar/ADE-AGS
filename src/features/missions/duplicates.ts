import type { MissionSummary } from "./types";

/**
 * Normaliza o texto para comparação: espaços múltiplos e quebras de linha viram
 * um único espaço e tudo em minúsculas.
 */
export function normalizeText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
}

export interface DuplicateDetectionResult {
  mission: MissionSummary;
  isRunning: boolean;
  isRecent: boolean;
}

/** Janela para considerar uma missão recente: 24 horas (em segundos). */
export const RECENT_MISSION_SECS = 24 * 3600;

/**
 * Procura se já existe uma missão com o mesmo título e objetivo:
 * - em andamento (`running`), ou
 * - recente (criada, iniciada ou encerrada nas últimas 24h).
 *
 * Pura.
 */
export function findDuplicateMission(
  missions: MissionSummary[],
  target: { id?: string; title: string; objective?: string | null; cwd?: string },
  nowSecs = Math.floor(Date.now() / 1000),
  recentWindowSecs = RECENT_MISSION_SECS
): DuplicateDetectionResult | null {
  const normTitle = normalizeText(target.title || "");
  const normObj = target.objective ? normalizeText(target.objective) : null;

  if (!normTitle) return null;

  for (const m of missions) {
    if (target.id && m.id === target.id) continue;

    const mTitle = normalizeText(m.title || "");
    if (mTitle !== normTitle) continue;

    if (normObj !== null) {
      const mObj = m.objective ? normalizeText(m.objective) : "";
      if (mObj !== normObj) continue;
    }

    const isRunning = m.status === "running";
    const timestamp = m.startedAt ?? m.createdAt;
    const isRecent = timestamp ? Math.abs(nowSecs - timestamp) <= recentWindowSecs : false;

    if (isRunning || isRecent) {
      return {
        mission: m,
        isRunning,
        isRecent,
      };
    }
  }

  return null;
}
