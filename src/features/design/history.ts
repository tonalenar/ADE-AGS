/**
 * Desfazer e refazer das operações de canvas (mover, redimensionar, criar, apagar; pranchetas, notas e
 * formas). Cada entrada sabe se desfazer e se refazer contra o backend; a pilha é pura e testável.
 */
export interface HistoryEntry {
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

export const HISTORY_LIMIT = 100;

export function createHistory(limit = HISTORY_LIMIT) {
  let past: HistoryEntry[] = [];
  let future: HistoryEntry[] = [];
  let busy = false;
  const run = async (from: HistoryEntry[], to: HistoryEntry[], key: "undo" | "redo"): Promise<HistoryEntry | null> => {
    if (busy) return null;
    const entry = from.pop();
    if (!entry) return null;
    busy = true;
    try {
      await entry[key]();
      to.push(entry);
      return entry;
    } catch (e) {
      // Falhou: a entrada volta para onde estava, para tentar de novo.
      from.push(entry);
      throw e;
    } finally {
      busy = false;
    }
  };
  return {
    /** Uma operação nova: entra no passado e apaga o futuro. */
    push(entry: HistoryEntry) {
      past.push(entry);
      if (past.length > limit) past = past.slice(past.length - limit);
      future = [];
    },
    undo: () => run(past, future, "undo"),
    redo: () => run(future, past, "redo"),
    canUndo: () => past.length > 0 && !busy,
    canRedo: () => future.length > 0 && !busy,
    clear() { past = []; future = []; },
    get size() { return { past: past.length, future: future.length }; },
  };
}
export type History = ReturnType<typeof createHistory>;

/**
 * Um id que muda quando a operação é refeita (recriar uma prancheta apagada gera id novo). As
 * entradas guardam esta caixa em vez do id solto.
 */
export interface IdRef { current: string }
export const idRef = (id: string): IdRef => ({ current: id });
