import { create } from "zustand";

import { addQuote, clipQuote, updateQuoteComment, type Quote } from "./quoteModel";
import type { QuoteSourceAnchor } from "./selectionModel";

/** Sessão ativa do editor flutuante de comentário sobre uma citação recém-inserida ou existente. */
export interface QuoteCommentEditSession {
  id: string;
  /** Quando `true` (veio direto do botão «Citar»), cancelar com Esc/Cancelar remove o chip recém-criado. */
  removeOnCancel: boolean;
  /** Âncora no trecho selecionado na timeline para posicionar o popover ao lado da seleção. */
  sourceAnchor?: QuoteSourceAnchor;
}

/**
 * As citações («Citar») esperando para ir na próxima mensagem, por conversa (a chave do cartão da sidebar).
 * Só na memória: somem ao enviar e ao fechar o app, como o texto que ainda não foi enviado.
 */
export const useQuoteStore = create<{
  byKey: Record<string, Quote[]>;
  openEditByKey: Record<string, QuoteCommentEditSession>;
}>(() => ({ byKey: {}, openEditByKey: {} }));

const NONE: Quote[] = [];

/** As citações pendentes de uma conversa (lista estável quando não há nenhuma). */
export function useQuotes(key: string | null | undefined): Quote[] {
  return useQuoteStore((s) => (key ? s.byKey[key] ?? NONE : NONE));
}

/** Sessão de edição de comentário aberta para a conversa, se houver. */
export function useQuoteCommentEdit(key: string | null | undefined): QuoteCommentEditSession | null {
  return useQuoteStore((s) => (key ? s.openEditByKey[key] ?? null : null));
}

export function addQuoteFor(
  key: string,
  input: { text: string; comment?: string; originItemId?: string },
): boolean {
  let added = false;
  useQuoteStore.setState((s) => {
    const current = s.byKey[key] ?? [];
    const next = addQuote(current, input);
    if (next === current) return s;
    added = true;
    return { byKey: { ...s.byKey, [key]: next } };
  });
  return added;
}

/**
 * Insere a citação (ou reutiliza uma idêntica já pendente) e abre imediatamente o editor de comentário,
 * espelhando o fluxo do botão «Cite» no T3 Code.
 */
export function addQuoteAndOpenCommentFor(
  key: string,
  input: { text: string; comment?: string; originItemId?: string },
  options?: { sourceAnchor?: QuoteSourceAnchor; removeOnCancel?: boolean },
): string | null {
  let targetId: string | null = null;
  useQuoteStore.setState((s) => {
    const current = s.byKey[key] ?? [];
    const next = addQuote(current, input);
    if (next !== current) {
      const created = next[next.length - 1]!;
      targetId = created.id;
      return {
        byKey: { ...s.byKey, [key]: next },
        openEditByKey: {
          ...s.openEditByKey,
          [key]: {
            id: created.id,
            removeOnCancel: options?.removeOnCancel ?? true,
            ...(options?.sourceAnchor ? { sourceAnchor: options.sourceAnchor } : {}),
          },
        },
      };
    }
    const text = clipQuote(input.text);
    const comment = (input.comment ?? "").trim();
    const originItemId = input.originItemId?.trim() || undefined;
    const existing = current.find(
      (q) => q.text === text && q.comment === comment && q.originItemId === originItemId,
    );
    if (!existing) return s;
    targetId = existing.id;
    return {
      openEditByKey: {
        ...s.openEditByKey,
        [key]: {
          id: existing.id,
          removeOnCancel: false,
          ...(options?.sourceAnchor ? { sourceAnchor: options.sourceAnchor } : {}),
        },
      },
    };
  });
  return targetId;
}

export function openQuoteCommentEditFor(key: string, session: QuoteCommentEditSession): void {
  useQuoteStore.setState((s) => ({
    openEditByKey: { ...s.openEditByKey, [key]: session },
  }));
}

export function closeQuoteCommentEditFor(key: string, id?: string): void {
  useQuoteStore.setState((s) => {
    const active = s.openEditByKey[key];
    if (!active || (id !== undefined && active.id !== id)) return s;
    const openEditByKey = { ...s.openEditByKey };
    delete openEditByKey[key];
    return { openEditByKey };
  });
}

export function updateQuoteCommentFor(key: string, id: string, comment: string): boolean {
  let valid = true;
  useQuoteStore.setState((s) => {
    const current = s.byKey[key] ?? [];
    const target = current.find((q) => q.id === id);
    if (!target) return s;
    const next = updateQuoteComment(current, id, comment);
    if (next === current && comment.trim() !== target.comment) {
      valid = false;
      return s;
    }
    return next === current ? s : { byKey: { ...s.byKey, [key]: next } };
  });
  return valid;
}

export function removeQuoteFor(key: string, id: string): void {
  useQuoteStore.setState((s) => {
    const left = (s.byKey[key] ?? []).filter((q) => q.id !== id);
    const byKey = { ...s.byKey };
    if (left.length > 0) byKey[key] = left;
    else delete byKey[key];
    if (s.openEditByKey[key]?.id !== id) return { byKey };
    const openEditByKey = { ...s.openEditByKey };
    delete openEditByKey[key];
    return { byKey, openEditByKey };
  });
}

export function clearQuotesFor(key: string): void {
  useQuoteStore.setState((s) => {
    const hasQuotes = key in s.byKey;
    const hasEdit = key in s.openEditByKey;
    if (!hasQuotes && !hasEdit) return s;
    const byKey = { ...s.byKey };
    delete byKey[key];
    if (!hasEdit) return { byKey };
    const openEditByKey = { ...s.openEditByKey };
    delete openEditByKey[key];
    return { byKey, openEditByKey };
  });
}
