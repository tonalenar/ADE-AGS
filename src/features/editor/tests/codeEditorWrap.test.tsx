// @vitest-environment happy-dom
import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodeEditor, type EditorHandle } from "@/features/editor/CodeEditor";
import { DEFAULT_DISPLAY_PREFS, saveDisplayPrefs } from "@/features/settings/displayPreferences";

/** Uma linha bem mais larga que qualquer janela: sem quebra de linha, ela só rola na horizontal. */
const LONG_LINE = `const texto = "${"palavra ".repeat(80)}";`;
const LABELS = { before: "antes", revert: "reverter", close: "fechar", added: "adicionado" };

let root: Root;
let host: HTMLDivElement;
let handle: RefObject<EditorHandle | null>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  handle = createRef<EditorHandle>();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  localStorage.clear();
});

// O `useTheme` do editor exige o provedor de tema, como no `main.tsx`.
const mount = () => act(async () => {
  root.render(
    <ThemeProvider>
      <CodeEditor path="arquivo.ts" doc={LONG_LINE} onDirty={() => {}} onSave={() => {}} handleRef={handle} changeLabels={LABELS} />
    </ThemeProvider>,
  );
});

/** A preferência de código (Aparência → Texto), gravada como o ajuste grava. */
const setCodeWrap = (codeWrap: boolean) => act(() => {
  saveDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, codeWrap });
});

const wrapping = () => host.querySelector(".cm-content")?.classList.contains("cm-lineWrapping") ?? false;

describe("quebra de linha no editor de arquivos", () => {
  it("com a preferência de código ligada, a linha longa quebra na largura da janela", async () => {
    setCodeWrap(true);
    await mount();
    expect(wrapping()).toBe(true);
  });

  it("sem a preferência, a linha longa rola na horizontal, como antes", async () => {
    setCodeWrap(false);
    await mount();
    expect(wrapping()).toBe(false);
  });

  it("trocar a preferência com o editor aberto muda a quebra sem remontar nem perder o texto", async () => {
    setCodeWrap(false);
    await mount();
    const editor = host.querySelector(".cm-editor");
    setCodeWrap(true);
    expect(wrapping()).toBe(true);
    expect(host.querySelector(".cm-editor")).toBe(editor);
    expect(handle.current?.getDoc()).toBe(LONG_LINE);
  });
});
