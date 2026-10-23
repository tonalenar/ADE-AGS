/** Regras puras da fila de mensagens (o selo e a lista), testáveis sem DOM. */
import type { PeerMessage, QueueCount } from "./types";

/** A primeira linha com conteúdo, cortada em `max` caracteres. */
export function firstLine(text: string, max = 90): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type AgeKey = "peerQueue.ageSeconds" | "peerQueue.ageMinutes" | "peerQueue.ageHours";

/** Há quanto tempo a mensagem espera, na unidade que se lê melhor. */
export function ageOf(nowMs: number, createdAt: number): { key: AgeKey; n: number } {
  const s = Math.max(0, Math.floor((nowMs - createdAt) / 1000));
  if (s < 60) return { key: "peerQueue.ageSeconds", n: s };
  if (s < 3600) return { key: "peerQueue.ageMinutes", n: Math.floor(s / 60) };
  return { key: "peerQueue.ageHours", n: Math.floor(s / 3600) };
}

/** As contagens do backend como mapa aba → quantas esperam (só as maiores que zero). */
export function countsToMap(list: readonly QueueCount[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { tabId, count } of list) if (count > 0) out[tabId] = count;
  return out;
}

/** Os dois mapas dizem o mesmo? (para não re-renderizar todos os selos à toa) */
export function sameCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * Dá para mover a mensagem `index` uma casa (`delta` −1 sobe, +1 desce)? Só as que esperam se movem,
 * e só entre si: a que está sendo digitada fica no topo.
 */
export function canMove(list: readonly PeerMessage[], index: number, delta: -1 | 1): boolean {
  const me = list[index];
  const other = list[index + delta];
  return !!me && !!other && me.state === "queued" && other.state === "queued";
}
