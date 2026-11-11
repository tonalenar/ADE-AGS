// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs, saveDisplayPrefs } from "@/features/settings/displayPreferences";
import { Markdown } from "@/shared/ui/Markdown";

/**
 * A matemática do Markdown das conversas (KaTeX via remark-math e rehype-katex). Só renderiza com a
 * preferência "Renderizar matemática" ligada, como no T3 Code: desligada, o `$` é texto.
 */

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  localStorage.clear();
});

const setMath = (renderMath: boolean) => saveDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, renderMath });
const renderMarkdown = (content: string) => act(async () => {
  root.render(<Markdown content={content} tone="chat" />);
});

describe("preferência de matemática", () => {
  it("vem desligada, como no T3 Code; só o `true` explícito liga", () => {
    expect(DEFAULT_DISPLAY_PREFS.renderMath).toBe(false);
    expect(parseDisplayPrefs({}).renderMath).toBe(false);
    expect(parseDisplayPrefs({ renderMath: "sim" }).renderMath).toBe(false);
    expect(parseDisplayPrefs({ renderMath: true }).renderMath).toBe(true);
  });
});

describe("renderização de matemática no Markdown", () => {
  it("com a preferência desligada, $…$ continua texto", async () => {
    setMath(false);
    await renderMarkdown("A área é $x^2$ aqui.");
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.textContent).toContain("$x^2$");
  });

  it("$…$ vira fórmula dentro do parágrafo", async () => {
    setMath(true);
    await renderMarkdown("A área é $x^2$ aqui.");
    expect(host.querySelector("p .katex")).not.toBeNull();
    expect(host.textContent).toContain("aqui.");
  });

  it("$$…$$ em linhas próprias vira bloco centralizado", async () => {
    setMath(true);
    await renderMarkdown("Veja:\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\nfim.");
    expect(host.querySelector(".katex-display")).not.toBeNull();
    expect(host.textContent).toContain("fim.");
  });

  it("um bloco ```math também renderiza", async () => {
    setMath(true);
    await renderMarkdown("```math\na^2 + b^2 = c^2\n```");
    expect(host.querySelector(".katex-display")).not.toBeNull();
  });

  it("valores em dólar continuam texto", async () => {
    setMath(true);
    await renderMarkdown("Custa $5 e $10 hoje.");
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.textContent).toContain("Custa $5 e $10 hoje.");
  });

  it("código não é interpretado como matemática", async () => {
    setMath(true);
    await renderMarkdown("Use `$x$` assim.");
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.querySelector("code")?.textContent).toBe("$x$");
  });

  it("uma fórmula inválida não derruba a conversa: o texto seguinte continua na tela", async () => {
    setMath(true);
    await renderMarkdown("Veja $\\frac{$ e continue.");
    expect(host.textContent).toContain("continue.");
  });
});
