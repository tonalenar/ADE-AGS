// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/features/agents/agentIcons", () => ({ agentIcon: () => () => null }));
vi.mock("@/app/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/platform")>();
  return { ...actual, DESKTOP_OS: "linux", MOD_LABEL: "Ctrl" };
});

import { ChatComposer } from "../ChatComposer";
import { QuoteSurfaceActiveProvider } from "../quotes/QuoteCards";
import { SelectionComment } from "../quotes/SelectionComment";
import { addQuoteAndOpenCommentFor, addQuoteFor, useQuoteStore } from "../quotes/quoteStore";
import { AgentBubble } from "../timeline/Bubbles";

let host: HTMLDivElement;
let root: Root;

const KEY = "thread:conv-dup";

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
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

function DualSurfaceScene() {
  return (
    <>
      {/* Simula o CanvasView mantido montado por baixo do ChatShell em EditorArea.tsx,
          onde @xyflow sobrescreve visibility: visible no nó enquanto o container fica escondido fora da tela. */}
      <div
        data-testid="hidden-canvas"
        style={{ visibility: "hidden", transform: "translateX(-300vw)" }}
      >
        <div data-thread-node={KEY} style={{ visibility: "visible" }}>
          <ChatComposer placeholder="canvas" quoteKey={KEY} onSubmit={async () => true} />
        </div>
      </div>

      {/* Conversa ativa no ChatShell */}
      <div data-chat-shell="">
        <div data-testid="timeline">
          <AgentBubble agentId="claude" label="Claude" itemId="msg-assist-1">
            <p>Avisos: Um teste automático antigo falhava antes das mudanças.</p>
          </AgentBubble>
        </div>
        <SelectionComment container={() => document.querySelector("[data-testid=timeline]")} quoteKey={KEY} />
        <ChatComposer placeholder="chat" quoteKey={KEY} onSubmit={async () => true} />
      </div>
    </>
  );
}

function mockDualChipGeometry() {
  const hiddenList = document.querySelector("[data-testid='hidden-canvas'] ul[aria-label='chat.quote.list']");
  const hiddenChip = document.querySelector("[data-testid='hidden-canvas'] li[data-assistant-citation-chip]");
  const visibleList = document.querySelector("[data-chat-shell] ul[aria-label='chat.quote.list']");
  const visibleChip = document.querySelector("[data-chat-shell] li[data-assistant-citation-chip]");
  if (hiddenList) vi.spyOn(hiddenList, "getBoundingClientRect").mockReturnValue(rectOf(-4000, 440, 220, 24));
  if (hiddenChip) vi.spyOn(hiddenChip, "getBoundingClientRect").mockReturnValue(rectOf(-4000, 440, 220, 24));
  if (visibleList) vi.spyOn(visibleList, "getBoundingClientRect").mockReturnValue(rectOf(400, 740, 220, 24));
  if (visibleChip) vi.spyOn(visibleChip, "getBoundingClientRect").mockReturnValue(rectOf(400, 740, 220, 24));
}

describe("editor de comentário de citação nunca duplica nem vaza de superfície oculta", () => {
  it("ao citar um trecho no chat com o mesmo fio montado num canvas oculto, abre apenas UM editor ancorado no chat", async () => {
    await act(async () => {
      root.render(<DualSurfaceScene />);
    });

    const p = document.querySelector("[data-chat-item-id='msg-assist-1'] p")!;
    const node = p.firstChild!;
    const selectionRect = { left: 420, top: 300, right: 680, bottom: 320, width: 260, height: 20 };
    vi.spyOn(p, "getBoundingClientRect").mockReturnValue(rectOf(360, 260, 620, 120));
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: node,
      focusNode: node,
      toString: () => "Um teste automático antigo",
      removeAllRanges: vi.fn(),
      getRangeAt: () => ({
        startContainer: node,
        endContainer: node,
        startOffset: 0,
        endOffset: 26,
        collapsed: false,
        getBoundingClientRect: () => selectionRect,
        getClientRects: () => [selectionRect],
      }),
    } as unknown as Selection);

    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    const citeBtn = document.querySelector("button[data-cite-toolbar]") as HTMLButtonElement | null;
    expect(citeBtn).not.toBeNull();

    await act(async () => {
      citeBtn!.click();
    });

    const editors = document.querySelectorAll("[data-citation-comment-editor]");
    expect(editors).toHaveLength(1);
    const editorEl = editors[0] as HTMLElement;
    expect(editorEl.style.left).toBe("360px");
  });

  it("ao abrir o comentário pelo lápis do chip no chat com canvas oculto montado, não abre segundo editor no canto esquerdo", async () => {
    addQuoteFor(KEY, { text: "Avisos: Um teste automático antigo", originItemId: "msg-assist-1" });
    await act(async () => {
      root.render(<DualSurfaceScene />);
    });
    mockDualChipGeometry();

    const visibleTrigger = document.querySelector(
      "[data-chat-shell] button[data-citation-comment-trigger]",
    ) as HTMLButtonElement;
    expect(visibleTrigger).not.toBeNull();

    await act(async () => {
      visibleTrigger.click();
    });

    const editors = document.querySelectorAll("[data-citation-comment-editor]");
    expect(editors).toHaveLength(1);
    const editorEl = editors[0] as HTMLElement;
    // Ancorado no chip visível (right 620 - width 320 = 300px), nunca clampado em 8px no canto esquerdo.
    expect(editorEl.style.left).toBe("300px");
  });

  it("com dois composers visíveis compartilhando a mesma chave, abrir edição pela store renderiza apenas UM editor", async () => {
    await act(async () => {
      root.render(
        <>
          <div data-testid="first">
            <ChatComposer placeholder="a" quoteKey={KEY} onSubmit={async () => true} />
          </div>
          <div data-testid="second">
            <ChatComposer placeholder="b" quoteKey={KEY} onSubmit={async () => true} />
          </div>
        </>,
      );
    });

    await act(async () => {
      addQuoteAndOpenCommentFor(KEY, { text: "trecho compartilhado" });
    });

    expect(document.querySelectorAll("[data-citation-comment-editor]")).toHaveLength(1);
  });

  it("um composer montado apenas em superfície oculta fora da tela não vaza editor no document.body", async () => {
    await act(async () => {
      root.render(
        <div
          data-testid="only-hidden-canvas"
          style={{ visibility: "hidden", transform: "translateX(-300vw)" }}
        >
          <div data-thread-node={KEY} style={{ visibility: "visible" }}>
            <ChatComposer placeholder="canvas" quoteKey={KEY} onSubmit={async () => true} />
          </div>
        </div>,
      );
    });

    await act(async () => {
      addQuoteAndOpenCommentFor(KEY, { text: "trecho fora da tela" });
    });

    expect(document.querySelectorAll("[data-citation-comment-editor]")).toHaveLength(0);
  });

  it("quando uma superfície fica inativa (ex.: canvas oculto ao trocar para o chat), o editor dela fecha e não duplica com o chat", async () => {
    addQuoteFor(KEY, { text: "trecho no canvas" });
    const renderMode = async (canvasActive: boolean, chatMounted: boolean) => {
      await act(async () => {
        root.render(
          <>
            <QuoteSurfaceActiveProvider active={canvasActive}>
              <div data-testid="canvas-surface">
                <ChatComposer placeholder="canvas" quoteKey={KEY} onSubmit={async () => true} />
              </div>
            </QuoteSurfaceActiveProvider>
            {chatMounted && (
              <div data-chat-shell="">
                <ChatComposer placeholder="chat" quoteKey={KEY} onSubmit={async () => true} />
              </div>
            )}
          </>,
        );
      });
    };

    // No canvas ativo, abrir pelo lápis mostra 1 editor.
    await renderMode(true, false);
    const canvasTrigger = document.querySelector(
      "[data-testid='canvas-surface'] button[data-citation-comment-trigger]",
    ) as HTMLButtonElement;
    await act(async () => {
      canvasTrigger.click();
    });
    expect(document.querySelectorAll("[data-citation-comment-editor]")).toHaveLength(1);

    // Ao trocar para Abas (canvas inativo, sem chat), nenhum editor vaza na tela.
    await renderMode(false, false);
    expect(document.querySelectorAll("[data-citation-comment-editor]")).toHaveLength(0);

    // Ao entrar no Chat (canvas inativo, chat montado), existe exatamente 1 editor (o do chat).
    await renderMode(false, true);
    expect(document.querySelectorAll("[data-citation-comment-editor]")).toHaveLength(1);
  });
});
