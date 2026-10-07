import type { MemoryAgentDraft } from "./types";

/** Limite de pendentes por dono (espelha `PENDING_MAX` do backend): cheio, propostas de agente viram rascunhos. */
export const PENDING_LIMIT = 32;
/** Limite da fila de rascunhos do workspace no backend. */
export const DRAFT_QUEUE_LIMIT = 256;
const MAX_TEXT = 600;

export interface DraftView {
  id: string;
  scope: string;
  actorKind: string;
  createdAt: number;
  key: string | null;
  kind: string | null;
  body: string | null;
  operation: string | null;
  /** Falso quando a proposta não pôde ser lida: a UI mostra aviso em vez de inventar conteúdo. */
  readable: boolean;
}

const text = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === "string" && v.trim() ? (v.length > max ? `${v.slice(0, max)}…` : v) : null;

/** A proposta é JSON de um agente: dado NÃO CONFIÁVEL. Só extrai textos curtos, nunca executa nada. */
export function toDraftView(d: MemoryAgentDraft): DraftView {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(d.proposal);
    if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return {
    id: String(d.id),
    scope: String(d.scope),
    actorKind: String(d.actorKind),
    createdAt: Number(d.createdAt),
    key: text(parsed?.key, 120),
    kind: text(parsed?.kind, 40),
    body: text(parsed?.body),
    operation: text(parsed?.operation, 40),
    readable: !!parsed && text(parsed.key, 120) !== null && text(parsed.body) !== null,
  };
}

/** O limite de 32 vale POR DONO (workspace ou cada missão), não somado: o maior grupo é o que enche. */
export function maxPendingPerOwner(groups: { items: unknown[] }[]): number {
  return groups.reduce((max, g) => Math.max(max, g.items.length), 0);
}

export type DraftNotice = "queueFull" | "inboxFull" | null;

/** Aviso mais grave primeiro: fila de rascunhos cheia, depois caixa de pendentes cheia. */
export function draftNotice(drafts: number, pendingInFullestOwner: number): DraftNotice {
  if (drafts >= DRAFT_QUEUE_LIMIT) return "queueFull";
  if (pendingInFullestOwner >= PENDING_LIMIT) return "inboxFull";
  return null;
}
