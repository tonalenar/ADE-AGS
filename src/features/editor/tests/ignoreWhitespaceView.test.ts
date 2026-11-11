// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getChunks, MergeView, unifiedMergeView } from "@codemirror/merge";

import { diffConfigFor } from "@/features/editor/ignoreWhitespace";

/** Um arquivo em que só a indentação de uma linha mudou (espaços viram tab). */
const BEFORE = "function f() {\n  return 1;\n}\n";
const AFTER = "function f() {\n\treturn 1;\n}\n";

function mount(): HTMLDivElement {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return parent;
}

/**
 * Os dois layouts da aba de diff, montados de verdade (DOM e merge do CodeMirror), com a mesma configuração
 * que o `DiffTab` passa. O que o usuário vê é a lista de chunks que o merge calcula.
 */
describe("a aba de diff com 'ignorar espaços'", () => {
  it("empilhado: troca só de indentação não vira mudança", () => {
    const view = new EditorView({
      parent: mount(),
      state: EditorState.create({
        doc: AFTER,
        extensions: [unifiedMergeView({ original: BEFORE, diffConfig: diffConfigFor(true) })],
      }),
    });
    expect(getChunks(view.state)?.chunks ?? []).toHaveLength(0);
    view.destroy();
  });

  it("empilhado: sem a opção, a mesma troca aparece (controle)", () => {
    const view = new EditorView({
      parent: mount(),
      state: EditorState.create({
        doc: AFTER,
        extensions: [unifiedMergeView({ original: BEFORE, diffConfig: diffConfigFor(false) })],
      }),
    });
    expect(getChunks(view.state)?.chunks ?? []).toHaveLength(1);
    view.destroy();
  });

  it("lado a lado: troca só de indentação não vira mudança nos dois lados", () => {
    const merge = new MergeView({
      parent: mount(),
      a: { doc: BEFORE },
      b: { doc: AFTER },
      diffConfig: diffConfigFor(true),
    });
    expect(getChunks(merge.b.state)?.chunks ?? []).toHaveLength(0);
    merge.destroy();
  });
});
