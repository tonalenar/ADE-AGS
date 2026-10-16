/**
 * O livro-razão de ações POR PORTAL (achado D6 do plano v2; também o sinal de idempotência do 3.4).
 *
 * O histórico do piloto vive dentro de um `act` e zera no seguinte: o Jev não sabia que um `act` anterior já tinha
 * adicionado o item ao carrinho, e o `act` seguinte o adicionava de novo (2 unidades). Aqui as últimas 10 ações de cada
 * portal sobrevivem entre `act`s. Cada uma guarda a contagem do carrinho antes e depois (o sinal do 3.4: «adicionar» que
 * já fez o carrinho subir não se repete). O piloto as recebe por `deps.prior()` já marcadas como «feito num act anterior»
 * e com a informação de se a página mudou desde então.
 *
 * Nunca guarda o valor digitado: só o que se fez («digitou em text field "Busca"»).
 */

/** Quantas ações o livro-razão mantém por portal. */
export const LEDGER_SIZE = 10;
/** Um portal parado há mais que isto começa de novo: a página de então já não é a de agora. */
const LEDGER_TTL_MS = 30 * 60_000;

export interface LedgerEntry {
  /** O número do `act` neste portal (1, 2, 3…). */
  actNo: number;
  goal: string;
  at: number;
  /** «clicou button "Adicionar"» — nunca o valor digitado. */
  what: string;
  /** A página mudou depois da ação? `null` = não se chegou a ler. */
  changed: boolean | null;
  cartBefore: number | null;
  cartAfter: number | null;
  /** O que estava ao lado do controle (o produto e o preço do «Adicionar»): distingue dois «Adicionar» iguais. */
  near?: string;
  /** O endereço da página em que a ação foi feita e o da página que ficou depois (sem consulta nem fragmento). */
  url?: string;
  urlAfter?: string;
}

/** O que o piloto recebe: estruturalmente um `Done` (jevPilot.ts), com a marca de «anterior» e a contagem do carrinho. */
export interface PriorAction {
  what: string;
  changed: boolean | null;
  auto?: boolean;
  previous: true;
  actNo: number;
  goal: string;
  cartBefore: number | null;
  cartAfter: number | null;
  near?: string;
  /** A página de agora difere da do fim daquele `act`? Só na última ação. `null` = não se sabe (ainda não leu a página). */
  pageChangedSince: boolean | null;
}

/** A página de agora, para descartar o histórico que não vale mais. Tudo opcional: o que não se sabe, não descarta. */
export interface PriorContext {
  /** O endereço da página de agora. */
  url?: string | null;
  /** Quantos itens o carrinho de agora mostra (`cartCount`). */
  cart?: number | null;
}

/** O endereço sem consulta nem fragmento: é com isso que se diz «a mesma página». */
export function bareUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/**
 * Esta ação ainda diz alguma coisa sobre a página de agora? Não, se foi feita em OUTRA página (outra tarefa no mesmo
 * portal: o «Adicionar ao carrinho» de uma loja não é o de outra) ou se subiu o carrinho e a página de agora mostra menos
 * (a página foi recarregada e o item já não está lá). Sem como saber, vale. Pura.
 */
export function stillApplies(entry: Pick<LedgerEntry, "url" | "urlAfter" | "cartBefore" | "cartAfter">, now: PriorContext = {}): boolean {
  const here = bareUrl(now.url);
  if (here) {
    const where = [bareUrl(entry.url), bareUrl(entry.urlAfter)].filter(Boolean);
    if (where.length > 0 && !where.includes(here)) return false;
  }
  const raised = entry.cartBefore !== null && entry.cartAfter !== null && entry.cartAfter > entry.cartBefore;
  if (raised && now.cart !== undefined && now.cart !== null && entry.cartAfter !== null && now.cart < entry.cartAfter) return false;
  return true;
}

export interface ActLedger {
  /** O próximo `act` neste portal. Devolve o número dele. */
  beginAct: (goal: string) => number;
  /** Anota uma ação (já executada, com o que se sabe). */
  record: (entry: Omit<LedgerEntry, "actNo" | "goal" | "at">) => LedgerEntry;
  /** O fim do `act`: a impressão da página em que parou. */
  endAct: (fingerprint: string | null) => void;
  /** As ações dos `act`s anteriores, marcadas. `fingerprint` = a página de agora (`null` = ainda não se sabe). */
  prior: (fingerprint: string | null, now?: PriorContext) => PriorAction[];
  /** Quantas ações há guardadas (para testes). */
  size: () => number;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** «carrinho 0→1» quando a contagem mudou; vazio se não se sabe ou não mudou. */
export function cartNote(before: number | null, after: number | null): string {
  if (before === null || after === null || before === after) return "";
  return `carrinho ${before}→${after}`;
}

/** Cria o livro-razão de UM portal. `now` é injetável para teste. */
export function createLedger(now: () => number = Date.now): ActLedger {
  let entries: LedgerEntry[] = [];
  let acts = 0;
  let current = 0;
  let goal = "";
  let endFingerprint: string | null = null;
  let touched = now();

  const expire = () => {
    if (now() - touched > LEDGER_TTL_MS) {
      entries = [];
      endFingerprint = null;
    }
    touched = now();
  };

  return {
    beginAct(g) {
      expire();
      acts += 1;
      current = acts;
      goal = g;
      return current;
    },
    record(entry) {
      const full: LedgerEntry = { ...entry, actNo: current, goal: clip(goal, 80), at: now() };
      entries.push(full);
      if (entries.length > LEDGER_SIZE) entries = entries.slice(-LEDGER_SIZE);
      return full;
    },
    endAct(fingerprint) {
      endFingerprint = fingerprint;
      touched = now();
    },
    prior(fingerprint, now = {}) {
      // Só o que veio de `act`s ANTERIORES ao atual e que ainda vale para a página de agora.
      const before = entries.filter((e) => e.actNo < current && stillApplies(e, now));
      return before.map((e, i) => {
        const last = i === before.length - 1;
        const changedSince = last && fingerprint !== null && endFingerprint !== null ? fingerprint !== endFingerprint : null;
        const marks = [
          `[feito num act anterior #${e.actNo}${e.goal ? ` "${clip(e.goal, 40)}"` : ""}]`,
          e.what,
        ].join(" ");
        const notes = [
          cartNote(e.cartBefore, e.cartAfter),
          last && changedSince !== null ? (changedSince ? "a página mudou desde o fim daquele act" : "a página é a mesma do fim daquele act") : "",
        ].filter(Boolean);
        return {
          what: `${marks}${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`,
          changed: e.changed,
          previous: true as const,
          actNo: e.actNo,
          goal: e.goal,
          cartBefore: e.cartBefore,
          cartAfter: e.cartAfter,
          ...(e.near ? { near: e.near } : {}),
          pageChangedSince: last ? changedSince : null,
        };
      });
    },
    size: () => entries.length,
  };
}

const ledgers = new Map<string, ActLedger>();

/** O livro-razão do portal `viewId` (um por navegador do canvas). */
export function ledgerOf(viewId: string): ActLedger {
  let ledger = ledgers.get(viewId);
  if (!ledger) {
    // Um teto no número de portais lembrados: os mais antigos saem primeiro.
    if (ledgers.size >= 50) ledgers.delete(ledgers.keys().next().value as string);
    ledger = createLedger();
    ledgers.set(viewId, ledger);
  }
  return ledger;
}

/** Esquece o portal (testes, ou quando o portal é fechado). */
export function forgetLedger(viewId: string): void {
  ledgers.delete(viewId);
}
