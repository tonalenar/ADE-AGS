import { create } from "zustand";

/**
 * ¿Hay un agente trabajando ahora? Se deduce de la terminal: una TUI de agente (Claude
 * Code, Codex…) anima un indicador y va escribiendo mientras piensa o ejecuta, y se calla
 * cuando termina su turno. Es la misma señal con la que `ags peer ask` decide que el
 * otro acabó de contestar.
 *
 * Lo que NO cuenta:
 * - los shells (`bash`): un `ls` no es un agente trabajando;
 * - el eco de lo que el usuario escribe: sin esto, teclear en el prompt de un agente
 *   quieto lo mostraría "trabajando".
 *
 * El pet usa esto para animarse (ver `useMascotState`).
 */

/** Cuánto silencio hace falta para dar a un agente por quieto. */
export const QUIET_MS = 3000;
/** El eco de una tecla llega enseguida; lo que sigue de un rato es trabajo de verdad. */
export const ECHO_MS = 600;

interface ActivityState {
  working: boolean;
  /** Cuántos agentes escribieron en los últimos `QUIET_MS`. */
  count: number;
}

export const useAgentActivity = create<ActivityState>(() => ({ working: false, count: 0 }));

/**
 * Para el TIEMPO de las misiones no basta un destello de salida: abrir una misión o una pestaña
 * hace que la TUI se redibuje (un golpe corto) y eso no es trabajo. Un agente que piensa o
 * ejecuta escribe sin parar (el indicador anima); por eso cuenta solo la salida SOSTENIDA.
 */
export const STREAK_GAP_MS = 1500;
export const SUSTAIN_MS = 2000;

const lastOutput = new Map<string, number>();
/** Desde cuándo escribe de corrido cada pestaña (se reinicia tras un silencio de `STREAK_GAP_MS`). */
const streakStart = new Map<string, number>();
const lastInput = new Map<string, number>();
/** Última salida de cada pestaña, sin caducar (`lastOutput` se poda a los `QUIET_MS`). */
const lastSeen = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Quiénes están activos a la hora `now`. Pura, para probar sin reloj. */
export function activeAgents(outputs: ReadonlyMap<string, number>, now: number): string[] {
  return [...outputs].filter(([, at]) => now - at < QUIET_MS).map(([id]) => id);
}

/** ¿Esta salida es el eco de algo que el usuario acaba de escribir? */
export function isEcho(inputAt: number | undefined, now: number): boolean {
  return inputAt !== undefined && now - inputAt < ECHO_MS;
}

/** Las pestañas de agente que escribieron hace menos de `QUIET_MS`: las que están trabajando ahora. */
export function activeTabIds(now = Date.now()): string[] {
  return activeAgents(lastOutput, now);
}

/** De las activas, las que escriben de corrido hace al menos `SUSTAIN_MS`. Pura. */
export function sustainedAgents(
  outputs: ReadonlyMap<string, number>,
  streaks: ReadonlyMap<string, number>,
  now: number,
): string[] {
  return activeAgents(outputs, now).filter((id) => now - (streaks.get(id) ?? now) >= SUSTAIN_MS);
}

/** Las pestañas que de verdad trabajan (salida sostenida): lo que cuenta para el tiempo de misión. */
export function sustainedTabIds(now = Date.now()): string[] {
  return sustainedAgents(lastOutput, streakStart, now);
}

function refresh(now = Date.now()): void {
  const count = activeAgents(lastOutput, now).length;
  for (const [id, at] of lastOutput) {
    if (now - at >= QUIET_MS) {
      lastOutput.delete(id);
      streakStart.delete(id);
    }
  }
  const next = { working: count > 0, count };
  const cur = useAgentActivity.getState();
  if (cur.working !== next.working || cur.count !== next.count) useAgentActivity.setState(next);
  // El reloj solo corre mientras hay algo que vigilar.
  if (count === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Una terminal de un agente escribió algo. */
export function markOutput(tabId: string | undefined, agentId: string | undefined): void {
  if (!tabId || !agentId || agentId === "bash") return;
  const now = Date.now();
  if (isEcho(lastInput.get(tabId), now)) return;
  const prev = lastOutput.get(tabId);
  if (prev === undefined || now - prev > STREAK_GAP_MS) streakStart.set(tabId, now);
  lastOutput.set(tabId, now);
  lastSeen.set(tabId, now);
  if (!useAgentActivity.getState().working) refresh(now);
  if (!timer) timer = setInterval(() => refresh(), 1000);
}

/** El usuario escribió en esa terminal. */
export function markInput(tabId: string | undefined): void {
  if (tabId) lastInput.set(tabId, Date.now());
}

/** Cuándo escribió por última vez el agente de la pestaña (sin contar el eco del usuario). */
export function lastOutputAt(tabId: string): number | undefined {
  return lastSeen.get(tabId);
}

/** Cuándo escribió por última vez el usuario en esa pestaña. */
export function lastInputAt(tabId: string): number | undefined {
  return lastInput.get(tabId);
}

/** Una tab que se cerró no puede quedar "trabajando". */
export function forgetTab(tabId: string | undefined): void {
  if (!tabId) return;
  lastSeen.delete(tabId);
  lastOutput.delete(tabId);
  streakStart.delete(tabId);
  lastInput.delete(tabId);
  refresh();
}
