// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/features/agents/agentIcons", () => ({ agentIcon: () => () => null }));
vi.mock("@/app/platform", async (importOriginal) => { const actual = await importOriginal<typeof import("@/app/platform")>(); return { ...actual, DESKTOP_OS: "linux", MOD_LABEL: "Ctrl" }; });

import { ChatComposer } from "../ChatComposer";
import { SelectionComment } from "../quotes/SelectionComment";
import { addQuoteFor, useQuoteStore } from "../quotes/quoteStore";
import { MAX_QUOTE_CHARS, withQuotes } from "../quotes/quoteModel";
import { isSelectionRectVisible, matchCommentShortcut, resolveSelectionActionPosition, selectionTarget, type SelectionLike } from "../quotes/selectionModel";
import { AgentBubble, PersonBubble } from "../timeline/Bubbles";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useQuoteStore.setState({ byKey: {}, openEditByKey: {} });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("selectionTarget e posicionamento/visibilidade (modelo puro)", () => {
  it("aceita seleção dentro de area citável, rejeita fora e rejeita elementos excluídos (botão, aria-hidden)", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div data-chat-item-id="m-1"><p data-quotable>fala do agente <button>copiar</button><span aria-hidden="true">oculto</span></p></div><p>fora</p>';
    const textNode = container.querySelector("[data-quotable]")!.firstChild!;
    const btnText = container.querySelector("button")!.firstChild!;
    const hiddenText = container.querySelector("[aria-hidden='true']")!.firstChild!;
    const outside = container.lastChild!.firstChild!;
    const rect = { left: 10, top: 20, right: 100, bottom: 40, width: 90, height: 20 };
    const sel = (a: Node, f: Node, text = "fala"): SelectionLike => ({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: a,
      focusNode: f,
      toString: () => text,
      getRangeAt: () => ({ getBoundingClientRect: () => rect }),
    });
    expect(selectionTarget(sel(textNode, textNode), container)).toMatchObject({ text: "fala", originItemId: "m-1", rect });
    expect(selectionTarget(sel(outside, outside), container)).toBeNull();
    expect(selectionTarget(sel(textNode, outside), container)).toBeNull();
    expect(selectionTarget(sel(btnText, btnText, "copiar"), container)).toBeNull();
    expect(selectionTarget(sel(hiddenText, hiddenText, "oculto"), container)).toBeNull();
    expect(selectionTarget(sel(textNode, textNode, "   "), container)).toBeNull();
    expect(selectionTarget(null, container)).toBeNull();
  });

  it("resolveSelectionActionPosition posiciona abaixo do fim da seleção dentro dos limites da viewport", () => {
    expect(
      resolveSelectionActionPosition({
        bounds: { left: 20, top: 40, width: 600, height: 400 },
        selectionRect: { right: 320, bottom: 150 },
        pointer: null,
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({ x: 320, y: 154 });

    expect(
      resolveSelectionActionPosition({
        bounds: { left: 20, top: 40, width: 600, height: 400 },
        selectionRect: { right: 999, bottom: 900 },
        pointer: null,
        viewport: { width: 800, height: 600 },
      }),
    ).toEqual({ x: 620, y: 440 });
  });

  it("isSelectionRectVisible verifica se ao menos parte da seleção está visível nos clipes", () => {
    expect(isSelectionRectVisible({ left: 10, top: 10, right: 80, bottom: 30 }, [{ left: 0, top: 0, right: 200, bottom: 200 }])).toBe(true);
    expect(isSelectionRectVisible({ left: 10, top: 220, right: 80, bottom: 240 }, [{ left: 0, top: 0, right: 200, bottom: 200 }])).toBe(false);
  });

  it("atalho de teclado respeita SO", () => {
    expect(matchCommentShortcut({ key: "m", altKey: true, metaKey: true, ctrlKey: false, shiftKey: false }, true)).toBe(true);
    expect(matchCommentShortcut({ key: "m", altKey: false, metaKey: false, ctrlKey: true, shiftKey: true }, false)).toBe(true);
    expect(matchCommentShortcut({ key: "k", altKey: false, metaKey: false, ctrlKey: true, shiftKey: true }, false)).toBe(false);
  });
});

describe("Citar: botão flutuante pílula (T3 Code) e fechamento", () => {
  function Scene({ includeUserBubble = false }: { includeUserBubble?: boolean }) {
    return (
      <>
        <div data-testid="timeline">
          <AgentBubble agentId="claude" label="Claude" itemId="msg-assist-1">
            <p>Cursor está pronto e a troca de agente também.</p>
          </AgentBubble>
          {includeUserBubble && <PersonBubble text="mensagem do usuário" itemId="msg-user-1" />}
        </div>
        <SelectionComment container={() => document.querySelector("[data-testid=timeline]")} quoteKey="conv-1" />
        <ChatComposer placeholder="p" quoteKey="conv-1" onSubmit={() => true} />
      </>
    );
  }

  const selectIn = async (selector: string, text: string, rect = { left: 100, top: 200, right: 180, bottom: 220, width: 80, height: 20 }) => {
    const el = document.querySelector(selector)!;
    const node = el.firstChild!;
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: node,
      focusNode: node,
      toString: () => text,
      removeAllRanges: vi.fn(),
      getRangeAt: () => ({
        startContainer: node,
        endContainer: node,
        startOffset: 0,
        endOffset: Math.min(text.length, (node.textContent ?? "").length),
        collapsed: false,
        getBoundingClientRect: () => rect,
        getClientRects: () => [rect],
      }),
    } as unknown as Selection);
    await act(async () => { document.dispatchEvent(new Event("selectionchange")); });
  };
  const citeButton = () => document.querySelector("button[data-cite-toolbar]") as HTMLButtonElement | null;

  it("selecionar texto numa fala do assistente mostra o botão pílula «Citar» com ícone de aspas; na fala do usuário não mostra", async () => {
    await act(async () => { root.render(<Scene includeUserBubble />); });
    expect(citeButton()).toBeNull();

    // Mensagem do usuário NÃO mostra botão de citar (como no T3 Code).
    await selectIn("[data-chat-item-id='msg-user-1'] .whitespace-pre-wrap", "mensagem do usuário");
    expect(citeButton()).toBeNull();

    // Mensagem do assistente mostra botão pílula "Citar" com ícone de aspas logo abaixo da seleção.
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca de agente");
    expect(citeButton()).not.toBeNull();
    expect(citeButton()!.textContent).toContain("chat.quote.cite");
    expect(citeButton()!.querySelector("svg")).not.toBeNull();
    expect(citeButton()!.className).toContain("rounded-full");
    expect(citeButton()!.style.top).toBe("224px");
  });

  it("seleção acima do limite desabilita o botão e exibe «Encurtar seleção»", async () => {
    await act(async () => { root.render(<Scene />); });
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "a".repeat(MAX_QUOTE_CHARS + 10));
    expect(citeButton()).not.toBeNull();
    expect(citeButton()!.disabled).toBe(true);
    expect(citeButton()!.textContent).toContain("chat.quote.shortenSelection");
  });

  it("clicar em «Citar» insere o chip e abre IMEDIATAMENTE o popover de comentário com foco e cursor no fim (sem blockquote)", async () => {
    await act(async () => { root.render(<Scene />); });
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca de agente");
    await act(async () => { citeButton()!.click(); });

    expect(useQuoteStore.getState().byKey["conv-1"]).toEqual([
      expect.objectContaining({ text: "troca de agente", comment: "", originItemId: "msg-assist-1" }),
    ]);
    expect(citeButton()).toBeNull();

    const editor = document.querySelector("[data-citation-comment-editor]");
    expect(editor).not.toBeNull();
    expect(editor!.querySelector("blockquote")).toBeNull();
    const input = document.querySelector("textarea[data-citation-comment-input]") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(0);

    // Digitar e pressionar Enter salva o comentário, fecha o editor e foca o composer
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "melhorar aqui");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector("[data-citation-comment-editor]")).toBeNull();
    expect(useQuoteStore.getState().byKey["conv-1"]![0]!.comment).toBe("melhorar aqui");
    expect(document.activeElement).toBe(document.querySelector("[data-chat-composer]"));
  });

  it("Esc ou Cancelar logo após clicar em «Citar» remove a citação recém-inserida e devolve o foco ao composer", async () => {
    await act(async () => { root.render(<Scene />); });
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca de agente");
    await act(async () => { citeButton()!.click(); });
    expect(useQuoteStore.getState().byKey["conv-1"]).toHaveLength(1);

    const input = document.querySelector("textarea[data-citation-comment-input]") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector("[data-citation-comment-editor]")).toBeNull();
    expect(useQuoteStore.getState().byKey["conv-1"]).toBeUndefined();
    expect(document.activeElement).toBe(document.querySelector("[data-chat-composer]"));
  });

  it("atalho Ctrl+Shift+M cita e também abre imediatamente o editor de comentário com foco", async () => {
    await act(async () => { root.render(<Scene />); });
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "Cursor está pronto");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(useQuoteStore.getState().byKey["conv-1"]).toHaveLength(1);
    const input = document.querySelector("textarea[data-citation-comment-input]") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("ao abrir o editor pelo lápis de um chip já salvo, Esc apenas fecha sem apagar o chip", async () => {
    addQuoteFor("conv-1", { text: "já salvo", comment: "nota inicial" });
    await act(async () => { root.render(<Scene />); });
    const trigger = document.querySelector("button[data-citation-comment-trigger]") as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    const input = document.querySelector("textarea[data-citation-comment-input]") as HTMLTextAreaElement;
    expect(input.value).toBe("nota inicial");
    expect(input.selectionStart).toBe("nota inicial".length);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector("[data-citation-comment-editor]")).toBeNull();
    expect(useQuoteStore.getState().byKey["conv-1"]).toHaveLength(1);
  });

  it("fecha o botão ao clicar fora, ao rolar, ao limpar a seleção e com Escape", async () => {
    await act(async () => { root.render(<Scene />); });

    // Fecha ao clicar fora
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca");
    expect(citeButton()).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true })); });
    expect(citeButton()).toBeNull();

    // Fecha ao rolar
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca");
    expect(citeButton()).not.toBeNull();
    await act(async () => { document.querySelector("[data-testid=timeline]")!.dispatchEvent(new Event("scroll", { bubbles: false })); });
    expect(citeButton()).toBeNull();

    // Fecha ao limpar seleção
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca");
    expect(citeButton()).not.toBeNull();
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    await act(async () => { document.dispatchEvent(new Event("selectionchange")); });
    expect(citeButton()).toBeNull();

    // Fecha com Escape
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca");
    expect(citeButton()).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(citeButton()).toBeNull();
  });

  it("acessível por teclado: Tab move o foco ao botão Citar e Enter/clique insere a citação", async () => {
    await act(async () => { root.render(<Scene />); });
    await selectIn("[data-chat-item-id='msg-assist-1'] p", "troca de agente");
    const btn = citeButton()!;
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(btn);
    await act(async () => { btn.click(); });
    expect(useQuoteStore.getState().byKey["conv-1"]).toHaveLength(1);
  });
});

describe("o composer leva as citações como chip estilo T3, com comentário opcional e remoção", () => {
  let submitted: [string, number][] = [];
  const mount = (key: string | null = "conv-1") =>
    act(async () => { root.render(<ChatComposer placeholder="p" quoteKey={key} onSubmit={(text, atts) => { submitted.push([text, atts.length]); }} />); });
  const chips = () => [...document.querySelectorAll("ul[aria-label='chat.quote.list'] > li")];

  beforeEach(() => { submitted = []; });

  it("cada citação vira um chip acima do campo, permite adicionar/editar comentário no popover e remover por «×»", async () => {
    addQuoteFor("conv-1", { text: "trecho longo citado", originItemId: "msg-1" });
    addQuoteFor("conv-1", { text: "outro", comment: "segundo" });
    await mount();
    expect(chips()).toHaveLength(2);
    expect(chips()[0]!.textContent).toContain("trecho longo citado");
    expect(chips()[1]!.textContent).toContain("segundo");

    // Abre editor de comentário opcional no primeiro chip e salva com Enter
    const editBtn = chips()[0]!.querySelector("button[data-citation-comment-trigger]") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    await act(async () => { editBtn.click(); });
    const commentField = document.querySelector("textarea[data-citation-comment-input]") as HTMLTextAreaElement;
    expect(commentField).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(commentField, "meu comentário");
      commentField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      commentField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(useQuoteStore.getState().byKey["conv-1"]![0]!.comment).toBe("meu comentário");

    // Remove o primeiro chip pelo ×
    const removeBtn = chips()[0]!.querySelector("button[data-citation-remove]") as HTMLButtonElement;
    await act(async () => { removeBtn.click(); });
    expect(chips()).toHaveLength(1);
    expect(useQuoteStore.getState().byKey["conv-1"]).toHaveLength(1);
  });


  it("Ctrl+Enter no popover de comentário salva e dispara o envio da mensagem", async () => {
    addQuoteFor("conv-1", { text: "trecho para envio", originItemId: "msg-1" });
    await mount();
    const editBtn = chips()[0]!.querySelector("button[data-citation-comment-trigger]") as HTMLButtonElement;
    await act(async () => { editBtn.click(); });
    const commentField = document.querySelector("textarea[data-citation-comment-input]") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(commentField, "enviar junto");
      commentField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      commentField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    // Submissão assíncrona limpa a lista e entrega o payload com o comentário salvo
    await act(async () => { await Promise.resolve(); });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]![0]).toContain('"comment": "enviar junto"');
    expect(chips()).toHaveLength(0);
  });

  it("clicar fora do popover de comentário grava o rascunho válido e fecha", async () => {
    addQuoteFor("conv-1", { text: "trecho", originItemId: "msg-1" });
    await mount();
    const editBtn = chips()[0]!.querySelector("button[data-citation-comment-trigger]") as HTMLButtonElement;
    await act(async () => { editBtn.click(); });
    const commentField = document.querySelector("textarea[data-citation-comment-input]") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(commentField, "rascunho salvo fora");
      commentField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }));
    });
    expect(document.querySelector("textarea[data-citation-comment-input]")).toBeNull();
    expect(useQuoteStore.getState().byKey["conv-1"]![0]!.comment).toBe("rascunho salvo fora");
  });

  it("enviar leva o texto + payload estruturado <assistant_citations>; só citação também vale e limpa", async () => {
    addQuoteFor("conv-1", { text: "trecho", comment: "ok?", originItemId: "msg-1" });
    await mount();
    expect((document.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { (document.querySelector("button[type=submit]") as HTMLElement).click(); });
    expect(submitted).toEqual([[withQuotes("", [{ text: "trecho", comment: "ok?", originItemId: "msg-1" }]), 0]]);
    expect(chips()).toHaveLength(0);
  });

  it("se o envio falha, as citações ficam", async () => {
    addQuoteFor("conv-1", { text: "trecho" });
    await act(async () => { root.render(<ChatComposer placeholder="p" quoteKey="conv-1" onSubmit={() => false} />); });
    await act(async () => { (document.querySelector("button[type=submit]") as HTMLElement).click(); });
    expect(chips()).toHaveLength(1);
  });

  it("sem conversa (tela «Nova conversa») não há citação nenhuma", async () => {
    await mount(null);
    expect(chips()).toHaveLength(0);
  });
});

describe("a bolha enviada mostra a citação renderizada como no T3, sem o payload cru", () => {
  it("exibe o chip dentro do balão com blockquote no popover ao clicar, sem <assistant_citations> cru", async () => {
    const text = withQuotes("o que acha?", [{ text: "Cursor está pronto", comment: "troque o título", originItemId: "m-1" }]);
    await act(async () => { root.render(<PersonBubble text={text} />); });
    expect(host.textContent).toContain("troque o título");
    expect(host.textContent).toContain("o que acha?");
    expect(host.textContent).not.toContain("<assistant_citations>");
    expect(host.textContent).not.toContain("[assistant-quote-1]");

    // Ao clicar no chip da citação, abre o popover com o trecho citado em blockquote + comentário
    const chipTrigger = host.querySelector("button[data-citation-bubble-chip]") as HTMLButtonElement;
    expect(chipTrigger).not.toBeNull();
    await act(async () => { chipTrigger.click(); });
    const bq = document.querySelector("blockquote");
    expect(bq?.textContent).toContain("Cursor está pronto");
  });

  it("só a citação, sem texto: mostra o chip dentro do balão sem vazar o payload cru", async () => {
    await act(async () => { root.render(<PersonBubble text={withQuotes("", [{ text: "trecho único", comment: "" }])} />); });
    expect(host.querySelector(".rounded-2xl")).not.toBeNull();
    expect(host.textContent).toContain("trecho único");
    expect(host.textContent).not.toContain("<assistant_citations>");
  });
});
