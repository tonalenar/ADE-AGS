// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../ChatComposer";
import { DEFAULT_CHAT_PREFS, saveChatPrefs } from "../chatPrefs";
import { useDocumentSpellcheck } from "../spellcheckPref";

const language = vi.hoisted(() => ({ value: "pt-BR" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: language.value } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

class FakeObserver {
  constructor(private cb: () => void) {}
  observe() { this.cb(); }
  disconnect() { /* nada */ }
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FakeObserver });
  localStorage.clear();
  saveChatPrefs({ ...DEFAULT_CHAT_PREFS });
  language.value = "pt-BR";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });

const mount = (props: { suggestion?: string | null; turnActive?: boolean } = {}) => act(async () => {
  root.render(<ChatComposer placeholder="p" onSubmit={async () => true} suggestion={props.suggestion} turnActive={props.turnActive} />);
});
const area = () => host.querySelector("textarea") as HTMLTextAreaElement;
const ghost = () => host.querySelector("[data-composer-suggestion]") as HTMLElement | null;
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  area().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
});
const type = (value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(area(), value);
  area().dispatchEvent(new Event("input", { bubbles: true }));
});

describe("ortografia no composer", () => {
  it("liga o corretor nativo e usa o idioma da interface", async () => {
    await mount();
    expect(area().getAttribute("spellcheck")).toBe("true");
    expect(area().getAttribute("lang")).toBe("pt-BR");
    expect(area().getAttribute("autocorrect")).toBe("off");
  });

  it("acompanha o idioma (en, es)", async () => {
    language.value = "es";
    await mount();
    expect(area().getAttribute("lang")).toBe("es");
  });

  it("desligado nas Configurações, o corretor sai", async () => {
    await act(async () => { saveChatPrefs({ ...DEFAULT_CHAT_PREFS, spellcheck: false }); });
    await mount();
    expect(area().getAttribute("spellcheck")).toBe("false");
  });

  it("comando «/» não é sublinhado", async () => {
    await mount();
    await type("/compact");
    expect(area().getAttribute("spellcheck")).toBe("false");
    await type("mensagem normal");
    expect(area().getAttribute("spellcheck")).toBe("true");
  });

  it("a preferência vai para o <html>", async () => {
    function Probe() { useDocumentSpellcheck(); return null; }
    await act(async () => { root.render(<Probe />); });
    expect(document.documentElement.spellcheck).toBe(true);
    await act(async () => { saveChatPrefs({ ...DEFAULT_CHAT_PREFS, spellcheck: false }); });
    expect(document.documentElement.spellcheck).toBe(false);
  });
});

describe("sugestão do próximo prompt (texto fantasma)", () => {
  it("aparece com o campo vazio e o agente parado", async () => {
    await mount({ suggestion: "Rode os testes" });
    expect(ghost()?.textContent).toBe("Rode os testes");
    expect(area().placeholder).toBe("");
  });

  it("Tab aceita: o texto entra no campo e o fantasma some", async () => {
    await mount({ suggestion: "Rode os testes" });
    await press("Tab");
    expect(area().value).toBe("Rode os testes");
    expect(ghost()).toBeNull();
  });

  it("→ também aceita", async () => {
    await mount({ suggestion: "Rode os testes" });
    await press("ArrowRight");
    expect(area().value).toBe("Rode os testes");
  });

  it("digitar descarta, e apagar não a traz de volta", async () => {
    await mount({ suggestion: "Rode os testes" });
    await type("o");
    expect(ghost()).toBeNull();
    await type("");
    expect(ghost()).toBeNull();
    expect(area().placeholder).toBe("p");
  });

  it("não aparece com a opção desligada", async () => {
    await act(async () => { saveChatPrefs({ ...DEFAULT_CHAT_PREFS, promptSuggestions: false }); });
    await mount({ suggestion: "Rode os testes" });
    expect(ghost()).toBeNull();
    await press("Tab");
    expect(area().value).toBe("");
  });

  it("não aparece com o agente trabalhando", async () => {
    await mount({ suggestion: "Rode os testes", turnActive: true });
    expect(ghost()).toBeNull();
  });

  it("Tab sem sugestão não faz nada de especial", async () => {
    await mount();
    await press("Tab");
    expect(area().value).toBe("");
  });
});
