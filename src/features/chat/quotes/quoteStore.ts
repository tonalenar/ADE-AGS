import { create } from "zustand";

import { addQuote, type Quote } from "./quoteModel";

/**
 * As citações («Comentar») esperando para ir na próxima mensagem, por conversa (a chave do cartão da sidebar). Só
 * na memória: somem ao enviar e ao fechar o app, como o texto que ainda não foi enviado.
 */
export const useQuoteStore = create<{ byKey: Record<string, Quote[]> }>(() => ({ byKey: {} }));

const NONE: Quote[] = [];

/** As citações pendentes de uma conversa (lista estável quando não há nenhuma). */
export function useQuotes(key: string | null | undefined): Quote[] {
  return useQuoteStore((s) => (key ? s.byKey[key] ?? NONE : NONE));
}

export function addQuoteFor(key: string, input: { text: string; comment: string }): void {
  useQuoteStore.setState((s) => {
    const next = addQuote(s.byKey[key] ?? [], input);
    return next === (s.byKey[key] ?? []) ? s : { byKey: { ...s.byKey, [key]: next } };
  });
}

export function removeQuoteFor(key: string, id: string): void {
  useQuoteStore.setState((s) => {
    const left = (s.byKey[key] ?? []).filter((q) => q.id !== id);
    const byKey = { ...s.byKey };
    if (left.length > 0) byKey[key] = left;
    else delete byKey[key];
    return { byKey };
  });
}

export function clearQuotesFor(key: string): void {
  useQuoteStore.setState((s) => {
    if (!(key in s.byKey)) return s;
    const byKey = { ...s.byKey };
    delete byKey[key];
    return { byKey };
  });
}
