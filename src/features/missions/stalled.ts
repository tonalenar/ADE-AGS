import { formatDuration } from "./timings";

/**
 * Agente parado: el orquestador le mandó una tarea con `ags peer tell` y el agente se quedó
 * quieto sin contestar. El orquestador no se entera solo (espera para siempre), así que la app
 * lo avisa. Todo acá es puro; el reloj y la terminal los pone `useStalledWatch`.
 *
 * Sin falso alarme:
 * - un agente pensando escribe sin parar → está "activo" y el reloj de silencio no corre;
 * - un agente que espera al usuario (aprobación, pregunta) muestra el diálogo en pantalla →
 *   se reconoce en las últimas líneas y no se avisa;
 * - si el usuario escribió en esa terminal hace poco, está atendiendo al agente.
 */

/** Cuánto silencio, tras la tarea o tras la última salida, para dar al agente por parado. */
export const STALL_MS = 120_000;
/** El plazo configurable no baja de acá: menos que esto es ruido (un turno largo de pensar). */
export const MIN_STALL_MS = 15_000;
/** Cada cuánto se revisa. */
export const STALL_CHECK_MS = 5000;
/** Salida que llega justo tras el `tell` es el eco del prompt: no prueba que trabajó. */
const ECHO_GRACE_MS = 3000;
/** Cuántas líneas del final de la pantalla se miran para reconocer un diálogo. */
const TAIL_LINES = 8;

export interface PendingTask {
  /** La pestaña que recibió la tarea. */
  tabId: string;
  /** La pestaña que la mandó (el orquestador). */
  fromTabId: string;
  /** Cuándo se mandó (ms epoch). */
  at: number;
  /** Ya se avisó de esta tarea: no se repite. */
  alerted: boolean;
}

/** Tareas sin respuesta, por pestaña de destino. */
export type PendingTasks = ReadonlyMap<string, PendingTask>;

/** Lo que emite el backend en `cc-peer-message`. */
export interface PeerMessage {
  kind: "tell" | "ask";
  fromTabId: string;
  toTabId: string | null;
  /** El texto del `tell` (para distinguir una tarea de un simple "obrigado"). */
  text?: string | null;
  atMs: number;
}

const ACK = /^(ok(ay)?|okey|obrigad[oa]|brigad[oa]|valeu|vlw|thanks?|thank you|thx|gracias|entendido|entendi|beleza|blz|perfeito|[óo]timo|show|certo|combinado|top|legal|fechado|received|got it|recebido|de nada|tmj)\b/i;

/** ¿Es un mensaje corto de cortesía/confirmación, sin pedido? No hay nada que contestar. Pura. */
export function isAck(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const plain = t.replace(/^[^\p{L}\p{N}]+/u, "");
  return t.length <= 40 && t.split(/\s+/).length <= 5 && !t.includes("?") && (plain === "" || ACK.test(plain));
}

/** Lee un plazo en ms de un texto (ajuste del usuario); vacío o inválido → `STALL_MS`. Pura. */
export function parseStallMs(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_STALL_MS ? n : STALL_MS;
}

/**
 * Aplica un mensaje entre agentes. Un `tell` del orquestador a un miembro abre una tarea
 * pendiente (una nueva reemplaza la anterior y reinicia el reloj). Cualquier mensaje DE un
 * agente prueba que está atendiendo y cierra la tarea que debía. Pura.
 */
export function applyMessage(pending: PendingTasks, msg: PeerMessage, isLead: (tabId: string) => boolean): Map<string, PendingTask> {
  const next = new Map(pending);
  next.delete(msg.fromTabId);
  if (msg.kind === "tell" && msg.toTabId && isLead(msg.fromTabId) && !isLead(msg.toTabId) && !isAck(msg.text)) {
    next.set(msg.toTabId, { tabId: msg.toTabId, fromTabId: msg.fromTabId, at: msg.atMs, alerted: false });
  }
  return next;
}

const WAITING_FOR_USER = [
  /\(y\/n\)|\[y\/n\]|\by\/n\b/i,
  /do you want to (proceed|allow|make|create|run|continue)/i,
  /\ballow\b.*\?/i,
  /esc to cancel|enter to confirm|press enter to/i,
  /\b(approve|approval|permission)\b/i,
  /\b(aprovar|aprova[cç][aã]o|permiss[aã]o|permiso|aprobar)\b/i,
  /^\s*[❯>]?\s*1\.\s*(yes|sim|s[ií])\b/im,
];

/** ¿La pantalla muestra un diálogo que espera una decisión del usuario? Pura. */
export function isWaitingForUser(lines: readonly string[]): boolean {
  const tail = lines.filter((l) => l.trim() !== "").slice(-TAIL_LINES).join("\n");
  return WAITING_FOR_USER.some((re) => re.test(tail));
}

/** La última línea con texto de la pantalla, recortada. Pura. */
export function lastScreenLine(lines: readonly string[], max = 160): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }
  return "";
}

/** Lo que el detector necesita saber del mundo, inyectado para probar sin terminales. */
export interface StallProbe {
  now: number;
  /** ¿Escribió hace menos de `QUIET_MS`? (pensando o ejecutando). */
  isActive: (tabId: string) => boolean;
  lastOutputAt: (tabId: string) => number | undefined;
  lastInputAt: (tabId: string) => number | undefined;
  screen: (tabId: string) => readonly string[] | null;
}

export interface Stall {
  tabId: string;
  fromTabId: string;
  /** Desde que se mandó la tarea. */
  sinceTaskMs: number;
  /** Desde la última señal de vida (salida del agente, entrada del usuario o la propia tarea). */
  quietMs: number;
  /** ¿Escribió algo tras la tarea? `false` = nunca arrancó. */
  worked: boolean;
  lastLine: string;
}

/** Las tareas que llevan parado más de `stallMs`, sin las que no deben avisar. Pura. */
export function findStalls(pending: PendingTasks, probe: StallProbe, stallMs = STALL_MS): Stall[] {
  const out: Stall[] = [];
  for (const task of pending.values()) {
    if (task.alerted || probe.isActive(task.tabId)) continue;
    const output = probe.lastOutputAt(task.tabId) ?? 0;
    const input = probe.lastInputAt(task.tabId) ?? 0;
    const quietMs = probe.now - Math.max(task.at, output, input);
    if (quietMs < stallMs) continue;
    const lines = probe.screen(task.tabId);
    if (lines && isWaitingForUser(lines)) continue;
    out.push({
      tabId: task.tabId,
      fromTabId: task.fromTabId,
      sinceTaskMs: probe.now - task.at,
      quietMs,
      worked: output > task.at + ECHO_GRACE_MS,
      lastLine: lines ? lastScreenLine(lines) : "",
    });
  }
  return out;
}

/** El aviso que recibe el orquestador (texto para el agente, en PT-BR como los briefings). Pura. */
export function stallMessage(name: string, stall: Stall): string {
  const state = stall.worked ? "trabalhou e se calou sem responder" : "não escreveu nada desde que recebeu a tarefa";
  const line = stall.lastLine ? `Última linha da tela: "${stall.lastLine}".` : "A tela dele está vazia.";
  return [
    `[Aviso automático do ADE AGS] O agente "${name}" recebeu uma tarefa há ${formatDuration(stall.sinceTaskMs)} e está parado há ${formatDuration(stall.quietMs)} (${state}).`,
    line,
    `Veja a tela com \`ags peer check "${name}"\` e decida: reenviar a tarefa (\`ags peer tell\`), reassinar a outro agente ou chamar o usuário. Se ele já terminou o que pediu, ignore este aviso.`,
  ].join(" ");
}

/** Marca como avisadas as tarefas de `stalls`. Pura. */
export function markAlerted(pending: PendingTasks, stalls: readonly Stall[]): Map<string, PendingTask> {
  const next = new Map(pending);
  for (const s of stalls) {
    const t = next.get(s.tabId);
    if (t) next.set(s.tabId, { ...t, alerted: true });
  }
  return next;
}
