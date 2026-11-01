// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve([]) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key), i18n: { language: "pt-BR" } }),
}));

import { ChatComposer } from "../ChatComposer";
import { SelectionComment } from "../quotes/SelectionComment";
import { addQuoteFor, useQuoteStore } from "../quotes/quoteStore";
import { matchCommentShortcut, selectionTarget, type SelectionLike } from "../quotes/selectionModel";
import { PersonBubble } from "../timeline/Bubbles";
import { withQuotes } from "../quotes/quoteModel";

const RECT = { left: 100, top: 200, right: 180, bottom: 220, width: 80, height: 20 };
function fakeSelection(text: string, anchor: Node | null, focus: Node | null = anchor, collapsed = false): SelectionLike & { removeAllRanges: () => void } {
  return { removeAllRanges: () => undefined, isCollapsed: collapsed, rangeCount: 1, anchorNode: anchor, focusNode: focus, toString: () => text, getRangeAt: () => ({ getBoundingClientRect: () => RECT as DOMRect }) };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useQuoteStore.setState({ byKey: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("a seleção que pode virar comentário", () => {
  const container = document.createElement("div");
  container.innerHTML = '<p data-quotable>fala do agente</p><p>fora</p>';
  const inside = container.querySelector("[data-quotable]")!.firstChild!;
  const outsideNode = container.querySelectorAll("p")[1]!.firstChild!;

  it("vale a seleção dentro de uma fala (agente ou pessoa), com o trecho e onde ela está", () => {
    expect(selectionTarget(fakeSelection("agente", inside), container)).toEqual({ text: "agente", rect: RECT });
  });

  it("não vale: seleção vazia, em branco, fora das falas ou de outro lugar da tela", () => {
    expect(selectionTarget(fakeSelection("", inside, inside, true), container)).toBeNull();
    expect(selectionTarget(fakeSelection("   ", inside), container)).toBeNull();
    expect(selectionTarget(fakeSelection("fora", outsideNode), container)).toBeNull();
    expect(selectionTarget(fakeSelection("x", inside, document.body), container)).toBeNull();
    expect(selectionTarget(null, container)).toBeNull();
  });

  it("o atalho: ⌥⌘M no macOS, Ctrl+Shift+M nos outros", () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "m", ...init });
    expect(matchCommentShortcut(key({ altKey: true, metaKey: true }), true)).toBe(true);
    expect(matchCommentShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(matchCommentShortcut(key({ ctrlKey: true }), false)).toBe(false);
    expect(matchCommentShortcut(key({ altKey: true, metaKey: true }), false)).toBe(false);
  });
});

describe("Comentar: botão, caixinha e a citação no composer", () => {
  function Scene() {
    return (
      <div>
        <div data-testid="timeline"><p data-quotable>Cursor está pronto e a troca de agente também.</p></div>
        <SelectionComment container={() => document.querySelector("[data-testid=timeline]")} quoteKey="conv-1" />
      </div>
    );
  }
  const select = async (text: string) => {
    const node = document.querySelector("[data-quotable]")!.firstChild!;
    vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection(text, node) as unknown as Selection);
    await act(async () => { document.dispatchEvent(new Event("selectionchange")); });
  };
  const button = () => document.querySelector("[aria-label='chat.quote.comment']") as HTMLButtonElement | null;
  const field = () => document.querySelector("textarea[aria-label='chat.quote.field']") as HTMLTextAreaElement | null;
  const type = (el: HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });

  it("selecionar um trecho mostra o botão «Comentar» junto à seleção; limpar a seleção o esconde", async () => {
    await act(async () => { root.render(<Scene />); });
    expect(button()).toBeNull();
    await select("troca de agente");
    expect(button()).not.toBeNull();
    expect(button()!.style.left).toBe("180px");
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    await act(async () => { document.dispatchEvent(new Event("selectionchange")); });
    expect(button()).toBeNull();
  });

  it("o botão não rouba a seleção do mouse (mousedown cancelado)", async () => {
    await act(async () => { root.render(<Scene />); });
    await select("troca");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => { button()!.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
  });

  it("a caixinha cita o trecho e Enter adiciona a citação com o comentário; a seleção e a caixa se vão", async () => {
    await act(async () => { root.render(<Scene />); });
    await select("troca de agente");
    await act(async () => { button()!.click(); });
    expect(document.body.textContent).toContain("troca de agente");
    await type(field()!, "e o resumo?");
    await key(field()!, "Enter");
    expect(useQuoteStore.getState().byKey["conv-1"]).toEqual([expect.objectContaining({ text: "troca de agente", comment: "e o resumo?" })]);
    expect(field()).toBeNull();
    expect(button()).toBeNull();
  });

  it("Shift+Enter quebra a linha (não envia); Enter sem comentário não adiciona; Esc fecha sem adicionar", async () => {
    await act(async () => { root.render(<Scene />); });
    await select("troca");
    await act(async () => { button()!.click(); });
    await key(field()!, "Enter", { shiftKey: true });
    await key(field()!, "Enter");
    expect(useQuoteStore.getState().byKey["conv-1"]).toBeUndefined();
    await key(field()!, "Escape");
    expect(field()).toBeNull();
    expect(useQuoteStore.getState().byKey["conv-1"]).toBeUndefined();
  });

  it("pelo teclado: o atalho abre a caixinha com o trecho selecionado", async () => {
    await act(async () => { root.render(<Scene />); });
    await select("troca");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true, shiftKey: true, bubbles: true })); });
    expect(field()).not.toBeNull();
  });

  it("as citações são da conversa: a de outra conversa não aparece", async () => {
    addQuoteFor("conv-1", { text: "a", comment: "b" });
    expect(useQuoteStore.getState().byKey["conv-2"]).toBeUndefined();
  });
});

describe("o composer leva as citações", () => {
  let submitted: [string, number][] = [];
  const mount = (key: string | null = "conv-1") => act(async () => { root.render(<ChatComposer placeholder="p" quoteKey={key} onSubmit={(text, atts) => { submitted.push([text, atts.length]); }} />); });
  const chips = () => [...document.querySelectorAll("ul[aria-label='chat.quote.list'] > li")];

  beforeEach(() => { submitted = []; });

  it("cada citação vira um chip acima do campo, com o trecho e o comentário, removível por «×»", async () => {
    addQuoteFor("conv-1", { text: "trecho longo citado", comment: "meu comentário" });
    addQuoteFor("conv-1", { text: "outro", comment: "segundo" });
    await mount();
    expect(chips()).toHaveLength(2);
    expect(chips()[0]!.textContent).toContain("trecho longo citado");
    expect(chips()[0]!.textContent).toContain("meu comentário");
    await act(async () => { (chips()[0]!.querySelector("button") as HTMLElement).click(); });
    expect(chips()).toHaveLength(1);
    expect(useQuoteStore.getState().byKey["conv-1"]).toHaveLength(1);
  });

  it("enviar leva o texto + o bloco de citações; só a citação (sem texto) também vale; e o composer limpa", async () => {
    addQuoteFor("conv-1", { text: "trecho", comment: "ok?" });
    await mount();
    expect((document.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { (document.querySelector("button[type=submit]") as HTMLElement).click(); });
    expect(submitted).toEqual([[withQuotes("", [{ text: "trecho", comment: "ok?" }]), 0]]);
    expect(chips()).toHaveLength(0);
  });

  it("se o envio falha, as citações ficam", async () => {
    addQuoteFor("conv-1", { text: "trecho", comment: "ok?" });
    await act(async () => { root.render(<ChatComposer placeholder="p" quoteKey="conv-1" onSubmit={() => false} />); });
    await act(async () => { (document.querySelector("button[type=submit]") as HTMLElement).click(); });
    expect(chips()).toHaveLength(1);
  });

  it("sem conversa (tela «Nova conversa») não há citação nenhuma", async () => {
    await mount(null);
    expect(chips()).toHaveLength(0);
  });
});

describe("a bolha enviada mostra a citação como cartão, sem o texto cru", () => {
  it("o bloco sai do balão: sobram o cartão (trecho + comentário) e a fala da pessoa", async () => {
    const text = withQuotes("o que acha?", [{ text: "Cursor está pronto", comment: "troque o título" }]);
    await act(async () => { root.render(<PersonBubble text={text} />); });
    expect(host.textContent).toContain("Cursor está pronto");
    expect(host.textContent).toContain("troque o título");
    expect(host.textContent).toContain("o que acha?");
    expect(host.textContent).not.toContain("[Citação]");
    expect(host.textContent).not.toContain("> Cursor");
    const cards = host.querySelector("ul[aria-label='chat.quote.list']")!;
    const bubble = [...host.querySelectorAll("div")].filter((d) => d.textContent === "o que acha?").pop()!;
    expect(cards.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("só a citação, sem texto: não sobra balão vazio", async () => {
    await act(async () => { root.render(<PersonBubble text={withQuotes("", [{ text: "a", comment: "b" }])} />); });
    expect(host.querySelector(".rounded-2xl")).toBeNull();
    expect(host.textContent).toContain("b");
  });
});
