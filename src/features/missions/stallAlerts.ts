/**
 * Alertas de "orquestrador parado" / "agente ocioso com tarefa pendente" e o tempo até todos
 * os agentes estarem trabalhando. O detector (backend) alimenta `useStallAlerts`; o QG do bot
 * e a aba da missão só leem. Tudo aqui é puro, menos a store.
 */
import { create } from "zustand";

import { formatDuration } from "./timings";

export type StallAlertKind =
  /** Um membro pediu algo ao orquestrador (peer ask/tell ou pergunta na tela) e ele não respondeu. */
  | "orchestrator_silent"
  /** Agente ocioso com tarefa pendente. */
  | "agent_idle";

export interface StallAlert {
  memberName: string;
  kind: StallAlertKind;
  /** Quanto tempo já esperou, em ms, no momento em que o alerta foi emitido. */
  waitedMs: number;
  /** Desde quando espera (ms epoch). */
  since: number;
}

/** Tempo até todos os agentes estarem trabalhando; `null` = ainda não (ou não medido). */
export interface StartupTime {
  /** ms desde o início da missão até o último agente mostrar atividade. */
  allWorkingMs: number | null;
  /** Agentes que ainda não mostraram atividade. */
  pendingNames: string[];
}

const KIND_ORDER: Record<StallAlertKind, number> = { orchestrator_silent: 0, agent_idle: 1 };

/** Ordena: orquestrador mudo primeiro, depois o que espera há mais tempo. Não muta a entrada. */
export function sortAlerts(alerts: readonly StallAlert[]): StallAlert[] {
  return [...alerts].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.since - b.since || a.memberName.localeCompare(b.memberName));
}

/** Espera atual (ms) de um alerta: cresce com o relógio, nunca fica abaixo do medido na emissão. */
export function currentWaitMs(alert: StallAlert, now: number): number {
  return Math.max(alert.waitedMs, now - alert.since, 0);
}

/** Texto curto de duração; reaproveita o formato das demais telas. */
export function waitLabel(alert: StallAlert, now: number): string {
  return formatDuration(currentWaitMs(alert, now));
}

/** Chave i18n do texto de cada tipo de alerta. */
export function alertKey(kind: StallAlertKind): string {
  return `missions.stall.kind.${kind}`;
}

/** Um alerta por (membro, tipo): o mais antigo vence. Pura. */
export function dedupeAlerts(alerts: readonly StallAlert[]): StallAlert[] {
  const seen = new Map<string, StallAlert>();
  for (const a of alerts) {
    const key = `${a.memberName}\u0000${a.kind}`;
    const prev = seen.get(key);
    if (!prev || a.since < prev.since) seen.set(key, a);
  }
  return [...seen.values()];
}

/** Resumo do início da missão. Pura. */
export function startupSummary(s: StartupTime | null | undefined): { state: "done" | "waiting" | "unknown"; ms: number | null; pending: string[] } {
  if (!s) return { state: "unknown", ms: null, pending: [] };
  if (s.pendingNames.length > 0) return { state: "waiting", ms: null, pending: s.pendingNames };
  if (s.allWorkingMs !== null) return { state: "done", ms: s.allWorkingMs, pending: [] };
  return { state: "unknown", ms: null, pending: [] };
}

interface StallAlertsState {
  alerts: Record<string, StallAlert[]>;
  startup: Record<string, StartupTime>;
  setAlerts: (missionId: string, alerts: StallAlert[]) => void;
  setStartup: (missionId: string, startup: StartupTime) => void;
  clear: (missionId: string) => void;
}

/** Ponto de ligação do detector: `setAlerts(missionId, [...])` e `setStartup(missionId, {...})`. */
export const useStallAlerts = create<StallAlertsState>((set) => ({
  alerts: {},
  startup: {},
  setAlerts: (missionId, alerts) => set((s) => ({ alerts: { ...s.alerts, [missionId]: sortAlerts(dedupeAlerts(alerts)) } })),
  setStartup: (missionId, startup) => set((s) => ({ startup: { ...s.startup, [missionId]: startup } })),
  clear: (missionId) => set((s) => {
    const alerts = { ...s.alerts };
    const startup = { ...s.startup };
    delete alerts[missionId];
    delete startup[missionId];
    return { alerts, startup };
  }),
}));
