import { create } from "zustand";

/** Os designs abertos em cada canvas: chave do canvas (`boardKey`) → ids. Só eles aparecem no canvas. */
export type OpenDesigns = Record<string, string[]>;

const STORAGE_KEY = "cc-design-open";

/** Lê o que foi guardado. Lixo vira nenhum aberto, nunca erro. Pura. */
export function parseOpenDesigns(raw: string | null): OpenDesigns {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: OpenDesigns = {};
  for (const [key, ids] of Object.entries(parsed)) {
    if (!Array.isArray(ids)) continue;
    const clean = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (clean.length > 0) out[key] = clean;
  }
  return out;
}

/** Abre `designId` no canvas `key`. Se já estava aberto, devolve o mesmo objeto. Pura. */
export function withOpened(open: OpenDesigns, key: string, designId: string): OpenDesigns {
  const ids = open[key] ?? [];
  if (ids.includes(designId)) return open;
  return { ...open, [key]: [...ids, designId] };
}

/** Fecha `designId` no canvas `key`; o canvas sem nenhum aberto sai do mapa. Pura. */
export function withClosed(open: OpenDesigns, key: string, designId: string): OpenDesigns {
  const ids = open[key];
  if (!ids?.includes(designId)) return open;
  const rest = ids.filter((id) => id !== designId);
  const next = { ...open };
  if (rest.length > 0) next[key] = rest;
  else delete next[key];
  return next;
}

/** O que está gravado agora, ou `null` se o storage não puder ser lido. */
function storedNow(): OpenDesigns | null {
  try {
    return parseOpenDesigns(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export const useOpenDesignsStore = create<{ open: OpenDesigns }>(() => ({ open: storedNow() ?? {} }));

/** Aplica a mudança sobre o que está gravado agora: outra janela pode ter gravado desde a última leitura. */
function change(update: (open: OpenDesigns) => OpenDesigns): void {
  const base = storedNow() ?? useOpenDesignsStore.getState().open;
  const next = update(base);
  useOpenDesignsStore.setState({ open: next });
  if (next === base) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* sem poder gravar, o aberto vale até fechar o app */
  }
}

/** Põe o design no canvas `key`. Sem canvas (`null`), não faz nada. */
export function openDesignOn(key: string | null, designId: string): void {
  if (!key) return;
  change((open) => withOpened(open, key, designId));
}

/** Recolhe o design do canvas `key`: os nós e os iframes dele saem da tela. */
export function closeDesignOn(key: string | null, designId: string): void {
  if (!key) return;
  change((open) => withClosed(open, key, designId));
}
