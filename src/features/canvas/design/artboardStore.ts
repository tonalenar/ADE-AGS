import { useEffect, useSyncExternalStore } from "react";

import { applyStorageDelta, emptySnapshot, sanitizeSnapshot, type StorageDelta, type StorageSnapshot } from "./artboardBoot";
import { designApi } from "./designApi";

/**
 * O estado que as pranchetas levam entre uma montagem e outra: o localStorage/sessionStorage de cada uma
 * (carregado do backend ANTES de o iframe existir, porque o script da página roda na montagem) e os erros
 * de script dos últimos documentos. O iframe só monta com o storage pronto.
 */
export const STORAGE_SAVE_MS = 250;
export const FRAME_ERROR_LIMIT = 5;
const FRAME_ERROR_TEXT = 300;

export interface FrameError { message: string; line: number | null; at: number }
interface Entry { status: "loading" | "ready" | "failed"; epoch: number }

const EMPTY_ERRORS: FrameError[] = [];
const entries = new Map<string, Entry>();
const snapshots = new Map<string, StorageSnapshot>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let errorState: Record<string, FrameError[]> = {};
const listeners = new Set<() => void>();

const emit = () => { for (const l of listeners) l(); };
const setEntry = (id: string, e: Entry) => { entries.set(id, e); emit(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Carrega o storage da prancheta uma vez. Falha = não pronta (a tela fica no aviso, sem gravar por cima). */
export function ensureArtboardStorage(id: string): void {
  const cur = entries.get(id);
  if (cur && cur.status !== "failed") return;
  setEntry(id, { status: "loading", epoch: cur?.epoch ?? 0 });
  designApi.storageGet(id).then(
    (raw) => {
      snapshots.set(id, sanitizeSnapshot(raw));
      setEntry(id, { status: "ready", epoch: entries.get(id)?.epoch ?? 0 });
    },
    () => setEntry(id, { status: "failed", epoch: entries.get(id)?.epoch ?? 0 }),
  );
}

export const isStorageReady = (id: string) => entries.get(id)?.status === "ready";
/** Troca a cada limpeza: a prancheta é recriada e recomeça com o storage vazio. */
export const storageEpochOf = (id: string) => entries.get(id)?.epoch ?? 0;
export const snapshotOf = (id: string): StorageSnapshot => snapshots.get(id) ?? emptySnapshot();

/** Uma gravação/remoção vinda do iframe. Recusada (fora do formato ou acima de 1 MiB) não muda nada. */
export function applyArtboardStorage(id: string, delta: StorageDelta): boolean {
  const current = snapshots.get(id);
  if (!current) return false;
  const res = applyStorageDelta(current, delta);
  if (!res.ok) return false;
  snapshots.set(id, res.snapshot);
  scheduleSave(id);
  return true;
}

function scheduleSave(id: string) {
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => { pending.delete(id); void persist(id); }, STORAGE_SAVE_MS));
}

async function persist(id: string) {
  const snap = snapshots.get(id);
  if (!snap) return;
  try {
    await designApi.storageSet(id, snap);
  } catch (e) {
    console.warn("design_storage_set", e);
  }
}

/** Grava tudo que está pendente (ao fechar o app, para não perder os últimos 250 ms). */
export async function flushArtboardStorage(): Promise<void> {
  const ids = [...pending.keys()];
  for (const id of ids) {
    clearTimeout(pending.get(id));
    pending.delete(id);
  }
  await Promise.all(ids.map(persist));
}

/** Apaga o que a prancheta guardou: zera o estado, troca a época e avisa o backend. */
export async function clearArtboardStorage(id: string): Promise<void> {
  clearTimeout(pending.get(id));
  pending.delete(id);
  snapshots.set(id, emptySnapshot());
  setEntry(id, { status: "ready", epoch: storageEpochOf(id) + 1 });
  await designApi.storageClear(id);
}

export function recordFrameError(id: string, err: { message: string; line: number | null }): void {
  const list = [...(errorState[id] ?? []), { message: err.message.slice(0, FRAME_ERROR_TEXT), line: err.line, at: Date.now() }].slice(-FRAME_ERROR_LIMIT);
  errorState = { ...errorState, [id]: list };
  emit();
}

export const frameErrorsOf = (id: string): FrameError[] => errorState[id] ?? EMPTY_ERRORS;

/** Um documento novo começa sem erros: o que ficou do anterior sai. */
export function resetFrameErrors(id: string): void {
  if (!errorState[id]) return;
  const rest = { ...errorState };
  delete rest[id];
  errorState = rest;
  emit();
}

export function useArtboardStorage(id: string, enabled: boolean): { ready: boolean; epoch: number } {
  useEffect(() => { if (enabled) ensureArtboardStorage(id); }, [id, enabled]);
  const entry = useSyncExternalStore(subscribe, () => entries.get(id));
  return { ready: entry?.status === "ready", epoch: entry?.epoch ?? 0 };
}

export function useFrameErrors(id: string): FrameError[] {
  return useSyncExternalStore(subscribe, () => errorState[id] ?? EMPTY_ERRORS);
}

export function useAllFrameErrors(): Record<string, FrameError[]> {
  return useSyncExternalStore(subscribe, () => errorState);
}
