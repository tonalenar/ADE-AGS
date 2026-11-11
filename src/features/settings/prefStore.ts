import { useSyncExternalStore } from "react";

/**
 * Uma preferência do aparelho: uma chave no `localStorage` com JSON. Lê o que veio (tolerando lixo),
 * grava só o que serve e avisa quem assina, então uma mudança nas Configurações aparece na hora nas
 * telas abertas. `apply` escreve o valor na janela (variável CSS, atributo, classe) e roda ao gravar e
 * uma vez no carregamento, antes da primeira pintura.
 */
export interface PrefStore<T> {
  /** O valor gravado, ou o padrão se não houver, se estiver ilegível ou se o armazenamento falhar. */
  read(): T;
  /** Grava (passando por `parse`), aplica na janela e avisa as telas. Devolve o valor que ficou. */
  save(next: T): T;
  /** O valor reativo, para um componente React. */
  use(): T;
}

export function createPrefStore<T>(options: {
  key: string;
  defaults: T;
  /** Recebe o que veio do armazenamento (ou o valor que se está gravando) e devolve só o que serve. */
  parse: (raw: unknown) => T;
  apply?: (value: T) => void;
}): PrefStore<T> {
  const listeners = new Set<() => void>();
  let snapshot: T | null = null;

  const read = (): T => {
    try {
      const raw = localStorage.getItem(options.key);
      return options.parse(raw ? JSON.parse(raw) : null);
    } catch {
      return options.defaults;
    }
  };

  const current = (): T => {
    snapshot ??= read();
    return snapshot;
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const save = (next: T): T => {
    const value = options.parse(next);
    try {
      localStorage.setItem(options.key, JSON.stringify(value));
    } catch {
      /* Sem armazenamento, a preferência vale só nesta sessão. */
    }
    snapshot = value;
    options.apply?.(value);
    for (const listener of listeners) listener();
    return value;
  };

  const use = (): T => useSyncExternalStore(subscribe, current, current);

  if (typeof document !== "undefined") options.apply?.(current());

  return { read, save, use };
}
