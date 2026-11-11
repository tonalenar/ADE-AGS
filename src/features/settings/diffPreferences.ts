import { createPrefStore } from "@/features/settings/prefStore";

/**
 * As preferências dos diffs deste aparelho (Configurações → Diffs): o layout (empilhado ou lado a
 * lado), as cores das adições e remoções, se os trechos sem mudança começam recolhidos e se as mudanças
 * só de espaço em branco somem (ligado é o padrão do T3). O botão na
 * barra do diff altera o mesmo layout, como no T3 Code.
 */

export type DiffLayout = "stacked" | "split";
export type DiffColorScheme = "red-green" | "blue-orange";

export interface DiffPrefs {
  layout: DiffLayout;
  colors: DiffColorScheme;
  /** Trechos sem mudança recolhidos ao abrir um diff (o padrão do T3); desligado, o arquivo inteiro aparece. */
  filesCollapsed: boolean;
  /** Some com as mudanças que são só de espaço, tab ou fim de linha (ver `ignoreWhitespace.ts`). Ligado é o padrão do T3. */
  ignoreWhitespace: boolean;
}

export const DIFF_PREFS_KEY = "cc-diff-prefs";

export const DEFAULT_DIFF_PREFS: DiffPrefs = {
  layout: "stacked",
  colors: "red-green",
  filesCollapsed: true,
  ignoreWhitespace: true,
};

/** Lê o que veio do armazenamento e devolve só o que serve; o resto volta ao padrão. Pura. */
export function parseDiffPrefs(raw: unknown): DiffPrefs {
  const o: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    layout: o.layout === "split" ? "split" : "stacked",
    colors: o.colors === "blue-orange" ? "blue-orange" : "red-green",
    filesCollapsed: o.filesCollapsed !== false,
    ignoreWhitespace: o.ignoreWhitespace !== false,
  };
}

/** O atributo do `<html>` que as variáveis de cor de `App.css` leem. Pura. */
export function diffAttributes(prefs: DiffPrefs): Record<string, string> {
  return { "data-diff-colors": prefs.colors };
}

function applyDiffPrefs(prefs: DiffPrefs): void {
  if (typeof document === "undefined") return;
  for (const [name, value] of Object.entries(diffAttributes(prefs))) document.documentElement.setAttribute(name, value);
}

const store = createPrefStore<DiffPrefs>({
  key: DIFF_PREFS_KEY,
  defaults: DEFAULT_DIFF_PREFS,
  parse: parseDiffPrefs,
  apply: applyDiffPrefs,
});

export const readDiffPrefs = store.read;
export const saveDiffPrefs = store.save;
export const useDiffPrefs = store.use;
