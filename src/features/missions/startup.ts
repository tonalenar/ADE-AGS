import type { NewSpan, TimingKind } from "./timings";

/**
 * Início de missão: todos os agentes têm que arrancar (mostrar atividade após o briefing) em até
 * `START_DEADLINE_MS` sem Enter manual. Aqui só há funções puras; quem as alimenta é `terminals.ts`
 * (via `SendTimings`) e quem lê é o QG (`useStallAlerts.setStartup`) e `ags mission timings`.
 */

/** Eventos de início gravados como spans pontuais (`startedMs == endedMs`), com `actor` = nome. */
export type StartEvent = Extract<TimingKind, `start_${"briefing" | "activity" | "retry" | "stalled"}`>;

/** Span pontual de um evento de início. Pura. */
export function startEventSpan(kind: StartEvent, actor: string, at: number): NewSpan {
  return { kind, actor, startedMs: at, endedMs: at, detail: "" };
}

export interface StartupState {
  openedAt: number;
  /** Todos os agentes esperados (orquestrador incluso), na ordem do time. */
  names: readonly string[];
  /** Quando cada agente mostrou atividade. */
  activityAt: ReadonlyMap<string, number>;
}

export interface StartupProgress {
  /** ms desde a abertura até o último agente arrancar; `null` enquanto faltar alguém. */
  allWorkingMs: number | null;
  /** Instante em que o último agente arrancou (ms epoch). */
  allWorkingAt: number | null;
  pendingNames: string[];
}

/** Quem falta arrancar e, se ninguém falta, quanto levou. Pura. */
export function startupProgress(state: StartupState): StartupProgress {
  const pendingNames = state.names.filter((n) => !state.activityAt.has(n));
  if (pendingNames.length > 0 || state.names.length === 0) return { allWorkingMs: null, allWorkingAt: null, pendingNames };
  const last = Math.max(...state.names.map((n) => state.activityAt.get(n) as number));
  return { allWorkingMs: Math.max(0, last - state.openedAt), allWorkingAt: last, pendingNames };
}

/** Registra a atividade de um agente sem mudar o estado anterior (só a primeira conta). Pura. */
export function withActivity(state: StartupState, name: string, at: number): StartupState {
  if (state.activityAt.has(name) || !state.names.includes(name)) return state;
  return { ...state, activityAt: new Map(state.activityAt).set(name, at) };
}

/** Span `start_all_working`: da abertura ao último agente arrancar. `null` se ainda falta alguém. Pura. */
export function allWorkingSpan(state: StartupState): NewSpan | null {
  const p = startupProgress(state);
  if (p.allWorkingAt === null) return null;
  return { kind: "start_all_working", actor: "all", startedMs: state.openedAt, endedMs: p.allWorkingAt, detail: "" };
}
