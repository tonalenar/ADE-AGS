import { isAck, isWaitingForUser, lastScreenLine, type PeerMessage } from "./stalled";
import { formatDuration } from "./timings";

/**
 * Orquestador parado: un integrante le pidió algo (`ags peer ask/tell`, o dejó una pregunta en su
 * pantalla) y el orquestador no contestó. Es el espejo de `stalled.ts` (orquestador → integrante).
 * El integrante queda esperando para siempre y nadie se entera, así que la app avisa.
 * Todo acá es puro; el reloj, las terminales y el aviso los pone `useLeadStallWatch`.
 *
 * Sin falso alarme:
 * - un orquestador trabajando escribe sin parar: cada salida suya reinicia el reloj de silencio;
 * - un orquestador que espera al usuario (aprobación) muestra el diálogo y no se le interrumpe;
 * - si el usuario escribió en su terminal hace poco, lo está atendiendo;
 * - un `tell` del integrante solo cuenta como pedido si pregunta (`?`) y no es una cortesía
 *   ("ok, obrigado"): la entrega final también llega como `tell` y no necesita respuesta.
 */

/** Cuánto silencio del orquestador, tras el pedido, para darlo por parado (3 min). */
export const LEAD_STALL_MS = 180_000;
/** El plazo configurable no baja de acá: menos que esto es ruido (un turno largo de pensar). */
export const MIN_LEAD_STALL_MS = 30_000;
/** Cada cuánto se revisa. */
export const LEAD_STALL_CHECK_MS = 5000;
/** Un integrante quieto con una pregunta en pantalla durante tanto tiempo está esperando respuesta. */
export const SCREEN_QUESTION_QUIET_MS = 45_000;
/** Cuántas líneas del final de la pantalla se miran en busca de una pregunta. */
const QUESTION_TAIL_LINES = 6;

export type LeadStallSource = "peer_ask" | "peer_tell" | "screen";

export interface PendingAsk {
  /** La pestaña del integrante que espera. */
  memberTabId: string;
  /** La pestaña del orquestador que debe contestar. */
  leadTabId: string;
  /** Desde cuándo espera (ms epoch). */
  at: number;
  source: LeadStallSource;
  /** Ya se avisó de este pedido: no se repite. */
  alerted: boolean;
}

/** Pedidos sin respuesta, por pestaña del integrante. */
export type PendingAsks = ReadonlyMap<string, PendingAsk>;

/** Lee el plazo en ms de un texto (ajuste del usuario); vacío o inválido → `LEAD_STALL_MS`. Pura. */
export function parseLeadStallMs(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_LEAD_STALL_MS ? n : LEAD_STALL_MS;
}

/** ¿Este mensaje de un integrante pide algo al orquestador? Pura. */
export function isRequestToLead(msg: PeerMessage): boolean {
  if (msg.kind === "ask") return true;
  const text = (msg.text ?? "").trim();
  return text.includes("?") && !isAck(text);
}

export interface AppliedMessage {
  pending: Map<string, PendingAsk>;
  /** Pedidos que este mensaje cerró (el orquestador contestó): sirven para medir la espera. */
  answered: Array<PendingAsk & { answeredAt: number }>;
}

/**
 * Aplica un mensaje entre agentes. Un `ask`/`tell`-pregunta de un integrante al orquestador abre un
 * pedido (uno nuevo reemplaza al anterior y reinicia el reloj). Un mensaje del orquestador a ese
 * integrante lo cierra. Un `ask` sin destino conocido se da por dirigido al orquestador. Pura.
 */
export function applyLeadMessage(
  pending: PendingAsks,
  msg: PeerMessage,
  isLead: (tabId: string) => boolean,
  leadTabId: string | null,
): AppliedMessage {
  const next = new Map(pending);
  const answered: AppliedMessage["answered"] = [];
  if (isLead(msg.fromTabId)) {
    const targets = msg.toTabId ? [msg.toTabId] : [];
    for (const id of targets) {
      const open = next.get(id);
      if (open) {
        answered.push({ ...open, answeredAt: msg.atMs });
        next.delete(id);
      }
    }
    return { pending: next, answered };
  }
  const toLead = msg.toTabId ? isLead(msg.toTabId) : msg.kind === "ask";
  const lead = msg.toTabId && isLead(msg.toTabId) ? msg.toTabId : leadTabId;
  if (toLead && lead && isRequestToLead(msg)) {
    next.set(msg.fromTabId, { memberTabId: msg.fromTabId, leadTabId: lead, at: msg.atMs, source: msg.kind === "ask" ? "peer_ask" : "peer_tell", alerted: false });
  }
  return { pending: next, answered };
}

const NOT_A_QUESTION = [/^\s*[›>❯$#]/, /esc to (cancel|interrupt)/i, /\?\s*for shortcuts/i];

/**
 * La pregunta que el integrante dejó en pantalla (una línea del final que acaba en `?`), o `null`.
 * Un diálogo de aprobación espera al usuario, no al orquestador: no cuenta. Pura.
 */
export function screenQuestion(lines: readonly string[]): string | null {
  if (isWaitingForUser(lines)) return null;
  const tail = lines.filter((l) => l.trim() !== "").slice(-QUESTION_TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trim();
    if (NOT_A_QUESTION.some((re) => re.test(line))) continue;
    if (/\?[\s"'»”)*_`]*$/.test(line) && line.length >= 8) return lastScreenLine([line]);
  }
  return null;
}

/** Lo que el detector necesita saber del mundo, inyectado para probar sin terminales. */
export interface LeadStallProbe {
  now: number;
  /** ¿Escribe de corrido ahora (trabajo sostenido, ver `sustainedTabIds`)? */
  isWorking: (tabId: string) => boolean;
  /** ¿Escribió hace menos de `QUIET_MS` (pensando o ejecutando)? */
  isActive: (tabId: string) => boolean;
  lastOutputAt: (tabId: string) => number | undefined;
  lastInputAt: (tabId: string) => number | undefined;
  screen: (tabId: string) => readonly string[] | null;
}

export interface LeadStall {
  memberTabId: string;
  leadTabId: string;
  source: LeadStallSource;
  /** Cuánto lleva el integrante esperando respuesta. */
  waitedMs: number;
  /** Desde la última señal de vida del orquestador. */
  quietMs: number;
  /** Texto de la pregunta, si se leyó de la pantalla del integrante. */
  question: string;
}

/** Pedidos de integrantes quietos con una pregunta en pantalla que aún no son un pedido abierto. Pura. */
export function findScreenAsks(
  members: ReadonlyMap<string, string>,
  pending: PendingAsks,
  probe: LeadStallProbe,
  quietMs = SCREEN_QUESTION_QUIET_MS,
): PendingAsk[] {
  const out: PendingAsk[] = [];
  for (const [memberTabId, leadTabId] of members) {
    if (pending.has(memberTabId) || probe.isActive(memberTabId)) continue;
    const lastOut = probe.lastOutputAt(memberTabId);
    if (lastOut === undefined || probe.now - lastOut < quietMs) continue;
    const lines = probe.screen(memberTabId);
    if (!lines || screenQuestion(lines) === null) continue;
    out.push({ memberTabId, leadTabId, at: lastOut, source: "screen", alerted: false });
  }
  return out;
}

/** Los pedidos que llevan sin respuesta más de `stallMs`, sin los que no deben avisar. Pura. */
export function findLeadStalls(pending: PendingAsks, probe: LeadStallProbe, stallMs = LEAD_STALL_MS): LeadStall[] {
  const out: LeadStall[] = [];
  for (const ask of pending.values()) {
    if (ask.alerted) continue;
    // Un orquestador que trabaja no está parado, aunque tarde en contestar.
    if (probe.isActive(ask.leadTabId) || probe.isWorking(ask.leadTabId)) continue;
    const alive = Math.max(ask.at, probe.lastOutputAt(ask.leadTabId) ?? 0, probe.lastInputAt(ask.leadTabId) ?? 0);
    const quietMs = probe.now - alive;
    if (quietMs < stallMs) continue;
    const leadLines = probe.screen(ask.leadTabId);
    if (leadLines && isWaitingForUser(leadLines)) continue;
    const memberLines = probe.screen(ask.memberTabId);
    out.push({
      memberTabId: ask.memberTabId,
      leadTabId: ask.leadTabId,
      source: ask.source,
      waitedMs: probe.now - ask.at,
      quietMs,
      question: memberLines ? screenQuestion(memberLines) ?? "" : "",
    });
  }
  return out;
}

/** El aviso que recibe el orquestador (PT-BR, como los briefings). Pura. */
export function leadStallMessage(name: string, stall: LeadStall): string {
  const how = stall.source === "screen" ? "deixou uma pergunta na tela" : "te enviou um pedido (ags peer ask/tell)";
  const line = stall.question ? ` Pergunta: "${stall.question}".` : "";
  return [
    `[Aviso automático do ADE AGS] O integrante "${name}" ${how} e espera sua resposta há ${formatDuration(stall.waitedMs)}.${line}`,
    `Veja a tela com \`ags peer check "${name}"\` e responda com \`ags peer tell "${name}" "<resposta>"\`. Se já respondeu, ignore este aviso.`,
  ].join(" ");
}

/** Marca como avisados los pedidos de `stalls`. Pura. */
export function markLeadAlerted(pending: PendingAsks, stalls: readonly LeadStall[]): Map<string, PendingAsk> {
  const next = new Map(pending);
  for (const s of stalls) {
    const a = next.get(s.memberTabId);
    if (a) next.set(s.memberTabId, { ...a, alerted: true });
  }
  return next;
}

/** Une pedidos nuevos (de pantalla) a los abiertos sin pisar los existentes. Pura. */
export function addAsks(pending: PendingAsks, asks: readonly PendingAsk[]): Map<string, PendingAsk> {
  const next = new Map(pending);
  for (const a of asks) if (!next.has(a.memberTabId)) next.set(a.memberTabId, a);
  return next;
}

/** Datos del span para las métricas (`ags mission timings`): cuánto esperó el integrante. Pura. */
export function leadStallSpan(
  ask: Pick<PendingAsk, "at" | "source">,
  endedMs: number,
  outcome: "answered" | "alerted",
  actor: string,
  target: string,
): { kind: "orchestrator_stall"; actor: string; target: string; startedMs: number; endedMs: number; detail: string } {
  return { kind: "orchestrator_stall", actor, target, startedMs: ask.at, endedMs: Math.max(endedMs, ask.at), detail: `${outcome}:${ask.source}` };
}
