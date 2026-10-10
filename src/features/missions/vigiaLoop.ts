import { isWorking } from "./stalled";

/**
 * O laço do Codex: o modelo emite milhares de itens de raciocínio vazios, sem chamar ferramenta
 * nem escrever mensagem e sem gastar token. Por fora o terminal parece vivo, porque o "Working
 * (Ns · esc to interrupt)" segue escrevendo, então nem o silêncio de saída nem o `isWorking`
 * acusam nada. O que denuncia é a tela: o mesmo "Working" por minutos e NADA mais mudando além
 * dos contadores. Tudo aqui é puro; quem põe o relógio e a tela é o Vigia.
 */

/** Tela igual (fora os contadores) por isto, ainda em "Working", é suspeita de laço. */
export const LOOP_MS = 8 * 60_000;
/** O mesmo terminal só é avisado de novo depois disto, se ainda estiver parado. */
export const LOOP_REPORT_MS = 15 * 60_000;
/** Quantas linhas (as últimas, não vazias) entram na impressão digital. */
const FINGERPRINT_LINES = 40;
/** Bolinhas e quadrinhos de spinner: mudam sozinhos e não dizem nada. */
const SPINNER = /[⠀-⣿•◦◉○●◐◑◒◓⏺✻✽✶✳✢·]/gu;
/** As linhas cujos números andam sozinhos: o "Working (…)" e o rodapé de contexto e tokens. */
const COUNTER_LINE = /esc to interrupt|context (left|window)|tokens?\b/i;
const NUMBER = /\d[\d,._]*/g;
/** `5s`, `1m 04s` e `1h 02m 03s` mudam de forma com o tempo; aqui viram a mesma coisa. */
const DURATION = /(?:#\s*[hms]\b\s*)+/g;

export interface LoopWatch {
  fingerprint: string;
  /** Desde quando a tela está com esta mesma impressão digital. */
  since: number;
  reportedAt?: number;
}

export interface LoopStep {
  next: LoopWatch | undefined;
  /** Há quanto tempo a tela não muda; só quando é para avisar agora. */
  stuckMs?: number;
}

function normalize(line: string): string {
  const calm = line.replace(SPINNER, " ");
  const flat = COUNTER_LINE.test(line) ? calm.replace(NUMBER, "#").replace(DURATION, "#t ") : calm;
  return flat.replace(/\s+/g, " ").trim();
}

/**
 * A tela sem o que muda sozinho: spinner e os números das linhas de contador (tempo, tokens, % de
 * contexto). Os números do resto ficam: um build que anda (`Compiling 34/120`) é tela mudando.
 * Duas telas com a mesma impressão digital só diferem nos contadores. Pura.
 */
export function screenFingerprint(lines: readonly string[]): string {
  return lines
    .filter((line) => line.trim() !== "")
    .slice(-FINGERPRINT_LINES)
    .map(normalize)
    .join("\n");
}

/**
 * Um passo do vigia de laço para um terminal. `lines` é a tela agora (`null` = não dá para ler).
 * Fora de "Working" ou com a tela mudada, a contagem recomeça. Pura.
 */
export function loopStep(prev: LoopWatch | undefined, lines: readonly string[] | null, now: number): LoopStep {
  if (!lines || !isWorking(lines)) return { next: undefined };
  const fingerprint = screenFingerprint(lines);
  if (!prev || prev.fingerprint !== fingerprint) return { next: { fingerprint, since: now } };
  const stuckMs = now - prev.since;
  const due = prev.reportedAt === undefined || now - prev.reportedAt >= LOOP_REPORT_MS;
  if (stuckMs >= LOOP_MS && due) return { next: { ...prev, reportedAt: now }, stuckMs };
  return { next: prev };
}

/** O aviso do chat: o que travou e o que foi (e não foi) feito. Pura. */
export function loopStuck(name: string, stuckMs: number): string {
  const min = Math.max(1, Math.round(stuckMs / 60_000));
  return `${name} está há ${min} min no mesmo "Working", com a tela parada (só os contadores mudam). Parece o laço do Codex: pensa sem agir.`;
}

export const LOOP_DONE = "só avisei, não interrompi o agente. Para destravar: Esc no terminal dele e uma mensagem pedindo para retomar de onde parou.";
