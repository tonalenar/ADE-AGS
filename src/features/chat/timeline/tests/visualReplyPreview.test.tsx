// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VISUAL_REPLY_SOURCE, VisualReplyPreview, visualReplyDocument } from "../VisualReplyPreview";

// O modal (neogestify-ui-components) não é o que está em teste: a prévia é que decide o que o quadro mostra.
vi.mock("@/shared/ui/ViewModal", () => ({
  ViewModal: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
}));

const HTML = "<p>agente</p>";
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<VisualReplyPreview html={HTML} onClose={() => {}} />);
  });
}

/** O quadro atual (o iframe), ou `null` se o pai já o tirou. */
const quadro = (): HTMLIFrameElement | null => host?.querySelector("iframe") ?? null;

/** O aviso de bloqueio, se estiver na tela. */
const aviso = (): Element | null => host?.querySelector('[role="status"]') ?? null;

/** Dispara o `load` do iframe, como o navegador faz quando o documento carrega. */
function carrega(frame: HTMLIFrameElement): void {
  act(() => {
    frame.dispatchEvent(new Event("load"));
  });
}

/** Um aviso `navigate-away` com a origem dada (a janela do quadro, ou outra). */
function avisoDeSaida(source: MessageEventSource | null): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { source: VISUAL_REPLY_SOURCE, kind: "navigate-away" }, source }));
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("VisualReplyPreview: o pai reage quando o quadro sai da página", () => {
  it("o primeiro load do quadro é o esperado: nada muda na tela", () => {
    mount();
    const original = quadro();
    expect(original).not.toBeNull();
    carrega(original!);
    expect(quadro()).toBe(original);
    expect(aviso()).toBeNull();
  });

  it("um segundo load (a página trocou de documento) restaura o srcdoc congelado e mostra o aviso", () => {
    mount();
    const original = quadro()!;
    carrega(original);
    carrega(original);
    const restaurado = quadro();
    expect(restaurado).not.toBeNull();
    expect(restaurado).not.toBe(original);
    expect(restaurado!.getAttribute("srcdoc")).toBe(visualReplyDocument(HTML));
    expect(aviso()).not.toBeNull();
  });

  it("o aviso navigate-away da janela do quadro tem o mesmo efeito: restaura o srcdoc e mostra o aviso", () => {
    mount();
    const original = quadro()!;
    carrega(original);
    avisoDeSaida(original.contentWindow);
    const restaurado = quadro();
    expect(restaurado).not.toBeNull();
    expect(restaurado).not.toBe(original);
    expect(restaurado!.getAttribute("srcdoc")).toBe(visualReplyDocument(HTML));
    expect(aviso()).not.toBeNull();
  });

  it("uma segunda saída depois de restaurado tira o quadro: o destino de fora nunca fica na tela", () => {
    mount();
    const original = quadro()!;
    carrega(original);
    carrega(original); // primeira saída: o documento congelado volta ao quadro
    const restaurado = quadro()!;
    carrega(restaurado); // o carregamento esperado do documento restaurado não conta como saída
    carrega(restaurado); // segunda saída: o quadro sai da tela
    expect(quadro()).toBeNull();
    expect(aviso()).not.toBeNull();
  });

  it("um aviso de outra janela não bloqueia nada", () => {
    mount();
    const original = quadro()!;
    carrega(original);
    avisoDeSaida(window);
    expect(quadro()).toBe(original);
    expect(aviso()).toBeNull();
  });
});
