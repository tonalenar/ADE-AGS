/**
 * O estado da comparação de modelos na tela: o diálogo aberto, as comparações registradas, o
 * que cada agente mudou e quais terminais ainda esperam o pedido. O registro de verdade fica no
 * backend (`comparisons.json`); aqui é só o reflexo.
 */
import { create } from "zustand";

import { compareList, compareStatus } from "./ipc";
import type { Comparison, EntryStatus } from "./types";

interface CompareState {
  /** O diálogo "Comparar modelos", com a pasta sugerida. */
  dialog: { cwd: string } | null;
  comparisons: Comparison[];
  loaded: boolean;
  /** O que cada agente mudou, por comparação e `pick`. */
  statuses: Record<string, Record<string, EntryStatus>>;
  /** Abas que ainda não receberam o pedido (a TUI está abrindo). Só desta execução. */
  pending: Record<string, true>;
  /** O diff aberto. */
  diff: { comparisonId: string; pick: string } | null;
}

export const useCompareStore = create<CompareState>(() => ({ dialog: null, comparisons: [], loaded: false, statuses: {}, pending: {}, diff: null }));

export function openCompareDialog(cwd = ""): void {
  useCompareStore.setState({ dialog: { cwd } });
}

export function closeCompareDialog(): void {
  useCompareStore.setState({ dialog: null });
}

export function openDiff(comparisonId: string, pick: string): void {
  useCompareStore.setState({ diff: { comparisonId, pick } });
}

export function closeDiff(): void {
  useCompareStore.setState({ diff: null });
}

export function setPending(tabId: string, on: boolean): void {
  const pending = { ...useCompareStore.getState().pending };
  if (on) pending[tabId] = true;
  else delete pending[tabId];
  useCompareStore.setState({ pending });
}

/** Substitui (ou acrescenta) uma comparação pelo id. */
export function upsertComparison(cmp: Comparison): void {
  const list = useCompareStore.getState().comparisons;
  const at = list.findIndex((c) => c.id === cmp.id);
  useCompareStore.setState({ comparisons: at >= 0 ? list.map((c, i) => (i === at ? cmp : c)) : [...list, cmp] });
}

export async function loadComparisons(): Promise<void> {
  try {
    useCompareStore.setState({ comparisons: await compareList(), loaded: true });
  } catch (e) {
    console.error(e);
    useCompareStore.setState({ loaded: true });
  }
}

export async function refreshStatus(id: string): Promise<void> {
  try {
    const list = await compareStatus(id);
    const byPick = Object.fromEntries(list.map((s) => [s.pick, s]));
    useCompareStore.setState({ statuses: { ...useCompareStore.getState().statuses, [id]: byPick } });
  } catch (e) {
    console.error(e);
  }
}
