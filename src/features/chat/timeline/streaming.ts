import type { TimelineItem } from "./types";

/**
 * O texto do agente chegando aos poucos, como no Claude Code. Puro (o relógio e o agendador vêm
 * de fora, para testar sem tempo real).
 *
 * - **Rascunhos (protocolo):** os pedaços (`delta` do `cc-chat-thread`) se acumulam por item até o
 *   item completo chegar; enquanto isso a timeline mostra o rascunho como um item comum, com o
 *   mesmo id do item final (`withDrafts`).
 * - **Lote por quadro:** os pedaços que chegam no mesmo quadro viram uma atualização só
 *   (`createFrameBatcher`), para não redesenhar a cada token.
 * - **Revelar:** o texto novo aparece palavra a palavra (`revealStart`/`revealTarget`/`revealAdvance`
 *   e `revealCut`), numa velocidade natural que acelera em texto longo, com teto por mensagem.
 */

export type DraftKind = "assistant" | "reasoning";

/** O texto de um item que ainda está chegando. */
export interface Draft {
  itemId: string;
  kind: DraftKind;
  text: string;
}

export interface DeltaInput {
  itemId: string;
  delta: string;
  kind?: DraftKind;
}

/** Os rascunhos depois de um pedaço: o mesmo item cresce no lugar; um item novo vai para o fim. */
export function appendDelta(drafts: Draft[], input: DeltaInput): Draft[] {
  if (!input.itemId || !input.delta) return drafts;
  const at = drafts.findIndex((d) => d.itemId === input.itemId);
  if (at < 0) return [...drafts, { itemId: input.itemId, kind: input.kind ?? "assistant", text: input.delta }];
  return drafts.map((d, k) => (k === at ? { ...d, text: d.text + input.delta } : d));
}

/** Vários pedaços de uma vez (um quadro). */
export function appendDeltas(drafts: Draft[], inputs: DeltaInput[]): Draft[] {
  return inputs.reduce(appendDelta, drafts);
}

/**
 * Os itens com os rascunhos que ainda não têm item completo no fim, como itens comuns (resposta
 * ou raciocínio). Um rascunho cujo item já chegou some: vale o item.
 */
export function withDrafts(items: TimelineItem[], drafts: Draft[]): TimelineItem[] {
  if (drafts.length === 0) return items;
  const known = new Set(items.map((i) => i.id));
  const extra = drafts.filter((d) => !known.has(d.itemId)).map((d): TimelineItem => ({ kind: d.kind, id: d.itemId, text: d.text }));
  return extra.length === 0 ? items : [...items, ...extra];
}

/**
 * Junta o que chega num quadro e entrega de uma vez. `schedule` agenda o `flush` (na tela, o
 * `requestAnimationFrame`) e devolve como cancelar; `flushNow` entrega já (antes de um evento que
 * precisa ver os pedaços em ordem, como o item completo).
 */
export function createFrameBatcher<T>(schedule: (run: () => void) => () => void, flush: (batch: T[]) => void) {
  let pending: T[] = [];
  let cancel: (() => void) | null = null;
  const flushNow = () => {
    if (cancel) {
      cancel();
      cancel = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    flush(batch);
  };
  return {
    push(value: T) {
      pending.push(value);
      if (!cancel) {
        cancel = schedule(() => {
          cancel = null;
          flushNow();
        });
      }
    },
    flushNow,
    get size() {
      return pending.length;
    },
  };
}

// ── Revelar ──────────────────────────────────────────────────────────────────

/** A velocidade natural, em caracteres por segundo (umas 30 palavras por segundo). */
export const REVEAL_BASE_CPS = 160;
/** O teto: o que falta revelar nunca leva mais que isso. */
export const REVEAL_MAX_MS = 1500;
/** Até quanto antes de abrir a conversa um item ainda conta como "chegou agora". */
export const FRESH_SLACK_MS = 10_000;

export interface Reveal {
  /** Quantos caracteres já apareceram (fracionário: o ritmo é contínuo, o corte é por palavra). */
  shown: number;
  /** Caracteres por milissegundo. */
  rate: number;
  /** O tamanho do texto que se está revelando. */
  target: number;
}

/** A velocidade para revelar `backlog` caracteres: a natural, ou mais rápida para caber no teto. */
export function revealRate(backlog: number): number {
  return Math.max(REVEAL_BASE_CPS / 1000, backlog / REVEAL_MAX_MS);
}

/** Começa a revelar um texto de `length` caracteres do zero. */
export function revealStart(length: number): Reveal {
  return { shown: 0, rate: revealRate(length), target: length };
}

/**
 * O texto mudou de tamanho (chegou mais um pedaço, ou o item final trocou o rascunho). Crescer
 * recalcula a velocidade pelo que falta; encolher só corta o que já apareceu.
 */
export function revealTarget(r: Reveal, length: number): Reveal {
  if (length === r.target) return r;
  const shown = Math.min(r.shown, length);
  if (length < r.target) return { ...r, shown, target: length };
  return { shown, rate: revealRate(length - shown), target: length };
}

/** `dtMs` depois. */
export function revealAdvance(r: Reveal, dtMs: number): Reveal {
  if (r.shown >= r.target) return r;
  return { ...r, shown: Math.min(r.target, r.shown + r.rate * Math.max(0, dtMs)) };
}

export const revealDone = (r: Reveal) => r.shown >= r.target;

/**
 * Onde cortar o texto para mostrar `shown` caracteres sem partir palavra: avança até o fim da
 * palavra em que o corte caiu. O espaço depois dela fica para a próxima.
 */
export function revealCut(text: string, shown: number): number {
  const n = Math.floor(shown);
  if (n <= 0) return 0;
  if (n >= text.length) return text.length;
  if (/\s/.test(text[n - 1]!)) return n;
  const rest = text.slice(n).search(/\s/);
  return rest < 0 ? text.length : n + rest;
}

/**
 * Se a fala do agente deve aparecer aos poucos: só a que chegou depois de abrir a conversa (fora
 * do que já estava lá na primeira leitura e com o carimbo de agora). O histórico aparece inteiro.
 */
export function isFresh(item: TimelineItem, baseline: ReadonlySet<string>, mountedAt: number): boolean {
  if (item.kind !== "assistant" || baseline.has(item.id)) return false;
  return item.at !== undefined && item.at >= mountedAt - FRESH_SLACK_MS;
}
