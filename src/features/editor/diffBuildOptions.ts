import type { DiffLayout } from "@/features/settings/diffPreferences";

/**
 * O que a aba de diff monta, conforme as preferências (Configurações → Diffs e Aparência). Pura: quem
 * decide o layout, o recolhimento e a quebra de linha é esta função; o `DiffTab` só a executa no
 * CodeMirror. Assim a regra se testa sem editor.
 */

/** Quantas linhas ficam visíveis antes e depois de uma mudança num trecho recolhido, e o mínimo para recolher. */
export const COLLAPSE_MARGIN = { margin: 3, minSize: 6 } as const;

export interface DiffBuildOptions {
  layout: DiffLayout;
  /** Os trechos sem mudança recolhidos, ou `undefined` para mostrar o arquivo inteiro. */
  collapseUnchanged: { margin: number; minSize: number } | undefined;
  lineWrapping: boolean;
}

export function diffBuildOptions(
  prefs: { layout: DiffLayout; filesCollapsed: boolean },
  codeWrap: boolean,
): DiffBuildOptions {
  return {
    layout: prefs.layout,
    collapseUnchanged: prefs.filesCollapsed ? { ...COLLAPSE_MARGIN } : undefined,
    lineWrapping: codeWrap,
  };
}
