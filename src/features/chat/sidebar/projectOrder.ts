/**
 * A ordem dos projetos na barra lateral (Configurações → Projetos). Pura: a barra entrega o que sabe de
 * cada projeto (a chave, normalizada, e o último pedido seu) e recebe a ordem de volta.
 *
 * - `activity`: o último pedido seu, como a barra sempre fez. É o padrão.
 * - `created`: quando o projeto apareceu pela primeira vez neste aparelho; o mais novo fica em cima.
 * - `manual`: a ordem que a pessoa definiu. Projeto que ainda não está na lista entra antes dos outros,
 *   como as conversas novas numa seção com ordem salva.
 */

export const PROJECT_ORDER_MODES = ["activity", "created", "manual"] as const;
export type ProjectOrderMode = (typeof PROJECT_ORDER_MODES)[number];

export interface ProjectOrderEntry {
  /** A pasta do projeto, já normalizada (`normalizeProjectPath`). */
  readonly key: string;
  /** Quando a pessoa pediu algo neste projeto pela última vez, em milissegundos. */
  readonly latest: number;
}

export interface ProjectOrderPrefs {
  readonly mode: ProjectOrderMode;
  /** A ordem escolhida à mão, de cima para baixo (chaves de pasta). */
  readonly manual: readonly string[];
  /** Quando cada projeto apareceu pela primeira vez, em milissegundos. */
  readonly created: Readonly<Record<string, number>>;
}

export const DEFAULT_PROJECT_ORDER_PREFS: ProjectOrderPrefs = { mode: "activity", manual: [], created: {} };

export function orderProjects<T extends ProjectOrderEntry>(entries: readonly T[], prefs: ProjectOrderPrefs): T[] {
  const byLatest = (a: T, b: T) => b.latest - a.latest;
  if (prefs.mode === "created") {
    return [...entries].sort((a, b) => (prefs.created[b.key] ?? 0) - (prefs.created[a.key] ?? 0) || byLatest(a, b));
  }
  if (prefs.mode === "manual") {
    const rank = new Map(prefs.manual.map((key, index) => [key, index] as const));
    return [...entries].sort((a, b) => {
      const ai = rank.get(a.key);
      const bi = rank.get(b.key);
      if (ai === undefined && bi === undefined) return byLatest(a, b);
      if (ai === undefined) return -1;
      if (bi === undefined) return 1;
      return ai - bi;
    });
  }
  return [...entries].sort(byLatest);
}

/** Troca a posição de `key` com a vizinha (`-1` sobe, `1` desce). Fora da lista, ou no limite, não muda nada. */
export function moveInOrder(keys: readonly string[], key: string, delta: -1 | 1): string[] {
  const index = keys.indexOf(key);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= keys.length) return [...keys];
  const next = [...keys];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Anota a data de aparecimento dos projetos que ainda não têm uma. Os que já têm ficam como estão: a data
 * é a da primeira vez, não muda a cada abertura.
 */
export function recordFirstSeen(created: Readonly<Record<string, number>>, keys: readonly string[], now: number): Record<string, number> {
  const next: Record<string, number> = { ...created };
  for (const key of keys) {
    if (next[key] === undefined) next[key] = now;
  }
  return next;
}
