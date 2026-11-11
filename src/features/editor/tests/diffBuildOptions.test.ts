import { describe, expect, it } from "vitest";

import { COLLAPSE_MARGIN, diffBuildOptions } from "@/features/editor/diffBuildOptions";
import { DEFAULT_DIFF_PREFS } from "@/features/settings/diffPreferences";

describe("opções de montagem do diff", () => {
  it("o padrão é empilhado, com os trechos sem mudança recolhidos e sem quebra de linha", () => {
    expect(diffBuildOptions(DEFAULT_DIFF_PREFS, false)).toEqual({
      layout: "stacked",
      collapseUnchanged: COLLAPSE_MARGIN,
      lineWrapping: false,
    });
  });

  it("'Expandidos' desliga o recolhimento: o arquivo inteiro aparece", () => {
    expect(diffBuildOptions({ layout: "stacked", filesCollapsed: false }, false).collapseUnchanged).toBeUndefined();
  });

  it("o layout lado a lado sai como pedido, e a quebra de linha segue a preferência do código", () => {
    expect(diffBuildOptions({ layout: "split", filesCollapsed: true }, true)).toMatchObject({ layout: "split", lineWrapping: true });
  });

  it("a margem de recolhimento é a do T3: três linhas de cada lado, a partir de seis", () => {
    expect(COLLAPSE_MARGIN).toEqual({ margin: 3, minSize: 6 });
  });
});
