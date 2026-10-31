import { create } from "zustand";

import type { TimelineItem } from "./types";
import { displayUserText } from "./userMessage";

/**
 * A mensagem da pessoa que acabou de ser enviada e ainda não voltou na timeline. Ela aparece na hora
 * (otimista) no fim do fio e some quando a mensagem real chega do transcript/protocolo.
 *
 * A espera existia porque a tela só mostrava a mensagem quando o backend a devolvia: no terminal, o
 * laço do canal lê o transcript a cada 1 s (`TICK`) e a janela ainda relê o arquivo inteiro (até
 * 4 MB) por IPC; no protocolo, a primeira mensagem de uma conversa ainda sobe o processo do agente
 * antes de o item existir.
 */
export interface PendingSend {
  id: string;
  text: string;
  at: number;
  /** Quantas mensagens da pessoa iguais a esta a timeline já tinha ao enviar. */
  baseline: number;
}

/** Passado isto sem eco, a mensagem otimista some (comando que não aparece no transcript, falha muda). */
export const PENDING_TTL_MS = 120_000;

const MAX = 20;

/** Compara pelo que a tela mostra (sem o resumo do time nem o prefixo "Só o orquestrador"). */
const norm = (s: string) => (displayUserText(s) ?? s).trim().replace(/\s+/g, " ").slice(0, 200);

/**
 * Quantas mensagens iguais a timeline já tem: a da pessoa, ou o aviso «não enviada» (`queueDropped`) de uma que
 * saiu da fila do agente sem ser enviada. Os dois são o desfecho de um envio.
 */
function userMatches(items: TimelineItem[], text: string): number {
  const key = norm(text);
  let n = 0;
  for (const i of items) {
    if ((i.kind === "user" || (i.kind === "notice" && i.label === "queueDropped")) && norm(i.text ?? "") === key) n++;
  }
  return n;
}

/** Cria o registro de um envio, olhando o que a timeline já tem. Puro. */
export function pendingSend(id: string, text: string, items: TimelineItem[], at: number): PendingSend {
  return { id, text, at, baseline: userMatches(items, text) };
}

/**
 * Quais envios ainda esperam o eco. Um envio está resolvido quando a timeline tem mais mensagens
 * iguais do que tinha ao enviar (contando os envios iguais anteriores, que também esperam o seu).
 * `working`: o agente está num turno, e uma mensagem na fila dele só entra no fio quando o turno dela começa
 * (pode demorar mais que o prazo): enquanto ele trabalha, o prazo não vale. Puro: `now` vem de fora.
 */
export function unreconciled(pending: PendingSend[], items: TimelineItem[], now: number, working = false): PendingSend[] {
  const seen = new Map<string, number>();
  return pending.filter((p) => {
    const key = norm(p.text);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    if (!working && now - p.at > PENDING_TTL_MS) return false;
    return userMatches(items, p.text) < p.baseline + index + 1;
  });
}

interface PendingState {
  byKey: Record<string, PendingSend[]>;
}

export const usePendingSends = create<PendingState>(() => ({ byKey: {} }));

let seq = 0;

/** Registra um envio da conversa `key` (o id da aba, ou `thread:<id>`). Devolve o id, para desfazer. */
export function addPending(key: string, text: string, items: TimelineItem[]): string {
  const id = `pending-${Date.now()}-${++seq}`;
  const entry = pendingSend(id, text, items, Date.now());
  usePendingSends.setState((s) => ({ byKey: { ...s.byKey, [key]: [...(s.byKey[key] ?? []), entry].slice(-MAX) } }));
  return id;
}

/** Tira um envio (o backend recusou, ou já voltou). */
export function dropPending(key: string, id: string): void {
  usePendingSends.setState((s) => ({ byKey: { ...s.byKey, [key]: (s.byKey[key] ?? []).filter((p) => p.id !== id) } }));
}

const EMPTY: PendingSend[] = [];

/** Os envios da conversa que ainda esperam o eco, na ordem. */
export function usePending(key: string, items: TimelineItem[], working = false): PendingSend[] {
  const all = usePendingSends((s) => s.byKey[key]) ?? EMPTY;
  // Sem relógio no render: o TTL só vale no próximo redesenho (a timeline muda a cada mensagem).
  return unreconciled(all, items, Date.now(), working);
}
