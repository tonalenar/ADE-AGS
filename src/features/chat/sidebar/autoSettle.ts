/**
 * Concluir sozinho (Configurações → Conversas): uma conversa parada há N dias sai da lista ativa, como se a
 * pessoa tivesse escolhido "Concluir". Nada é apagado: ela volta com "Reabrir" ou com um pedido seu.
 *
 * Como no T3 Code, não concluem sozinhas: a conversa fixada, a que trabalha ou espera você (aprovação ou
 * pergunta) e a aberta agora. A regra de "PR mesclado" do T3 fica de fora: o chat deste app não tem PR ligado.
 * Pura: recebe a lista e o relógio, e devolve o que venceu.
 */

export const AUTO_SETTLE_CHOICES = ["off", "3", "7", "14", "30"] as const;
export type AutoSettleChoice = (typeof AUTO_SETTLE_CHOICES)[number];

/** Desligado por padrão: concluir sozinho tira a conversa da lista, e isso não deve acontecer sem pedido. */
export const DEFAULT_AUTO_SETTLE: AutoSettleChoice = "off";

const DAY_MS = 86_400_000;

/** Os dias de inatividade da escolha, ou `null` quando está desligado. */
export function autoSettleDays(choice: AutoSettleChoice): number | null {
  return choice === "off" ? null : Number(choice);
}

/** Lixo gravado no aparelho vale o padrão (desligado). */
export function parseAutoSettleChoice(raw: unknown): AutoSettleChoice {
  return (AUTO_SETTLE_CHOICES as readonly unknown[]).includes(raw) ? (raw as AutoSettleChoice) : DEFAULT_AUTO_SETTLE;
}

export interface AutoSettleCandidate {
  readonly tabId: string;
  readonly pinned: boolean;
  /** Trabalhando, ou esperando a pessoa (aprovação ou pergunta pendente). */
  readonly busy: boolean;
  /** É a conversa aberta agora: nunca some sozinha debaixo da pessoa. */
  readonly selected: boolean;
}

export interface AutoSettleInput {
  /** Agora, em milissegundos. */
  readonly now: number;
  readonly days: number;
  readonly candidates: readonly AutoSettleCandidate[];
  /** Quando a pessoa pediu algo pela última vez em cada conversa, em segundos (como a barra guarda). */
  readonly lastUserAt: Readonly<Record<string, number>>;
}

function eligible(candidate: AutoSettleCandidate): boolean {
  return !candidate.pinned && !candidate.busy && !candidate.selected;
}

/**
 * Monta as candidatas a partir da lista da barra. Só entram conversas estruturadas (`threadOf` devolve o id da
 * thread): uma conversa de terminal não tem o estado "concluída" e não concluiria. As já concluídas saem.
 */
export function autoSettleCandidates(input: {
  readonly tabIds: readonly string[];
  readonly busy: readonly string[];
  readonly pinned: readonly string[];
  readonly selectedId: string | null;
  readonly settledThreadIds: ReadonlySet<string>;
  readonly threadOf: (tabId: string) => string | null;
}): AutoSettleCandidate[] {
  const busy = new Set(input.busy);
  const pinned = new Set(input.pinned);
  const out: AutoSettleCandidate[] = [];
  for (const tabId of input.tabIds) {
    const threadId = input.threadOf(tabId);
    if (!threadId || input.settledThreadIds.has(threadId)) continue;
    out.push({ tabId, pinned: pinned.has(tabId), busy: busy.has(tabId), selected: tabId === input.selectedId });
  }
  return out;
}

/** As conversas elegíveis cujo último pedido seu é mais velho que o prazo. Sem data, nada se conclui. */
export function autoSettleDue(input: AutoSettleInput): string[] {
  const limit = input.days * DAY_MS;
  return input.candidates
    .filter(eligible)
    .filter((candidate) => {
      const at = input.lastUserAt[candidate.tabId];
      return at !== undefined && input.now - at * 1000 >= limit;
    })
    .map((candidate) => candidate.tabId);
}

/** Quando a próxima conversa elegível vence, em milissegundos; `null` se nenhuma tem data. */
export function nextAutoSettleAt(input: AutoSettleInput): number | null {
  const limit = input.days * DAY_MS;
  let next: number | null = null;
  for (const candidate of input.candidates) {
    if (!eligible(candidate)) continue;
    const at = input.lastUserAt[candidate.tabId];
    if (at === undefined) continue;
    const due = at * 1000 + limit;
    if (next === null || due < next) next = due;
  }
  return next;
}
