// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CitationCommentPopover } from "../quotes/QuoteCards";
import type { QuoteSourceAnchor } from "../quotes/selectionModel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "pt-BR" } }) }));

let host: HTMLDivElement;
let root: Root;
let source: HTMLElement;
let sourceTop: number;

const anchor = (): QuoteSourceAnchor => ({
  source,
  range: { getBoundingClientRect: () => ({ left: 10, top: sourceTop, right: 200, bottom: sourceTop + 20, width: 190, height: 20 }) } as unknown as Range,
  rect: { left: 10, top: sourceTop, right: 200, bottom: sourceTop + 20, width: 190, height: 20 },
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  sourceTop = 120;
  source = document.createElement("p");
  source.textContent = "fala do agente";
  document.body.appendChild(source);
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); source.remove(); vi.restoreAllMocks(); });

async function openWithDraft(onSave: (comment: string) => boolean, onClose: () => void) {
  await act(async () => {
    root.render(<CitationCommentPopover item={{ id: "q1", text: "fala do agente", comment: "", originItemId: "m-1" }} anchorEl={null} sourceAnchor={anchor()} onSave={onSave} onCancel={() => undefined} onClose={onClose} />);
  });
  const area = document.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "minha observação");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("o observador do editor não mede a fonte a cada mutação do documento", () => {
  it("mutacoes_do_streaming_medem_a_fonte_uma_vez_por_quadro: vinte mutações seguidas não chamam a medição vinte vezes", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    try {
      await openWithDraft(() => true, () => undefined);
      // Os quadros pedidos pela abertura passam antes da contagem.
      await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
      const measure = vi.mocked(source.getBoundingClientRect);
      measure.mockClear();
      for (let i = 0; i < 20; i++) {
        document.body.appendChild(document.createElement("span"));
        await act(async () => {});
      }
      // A rajada não mede nada: a medição fica para o quadro.
      expect(measure.mock.calls.length).toBe(0);
      await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
      // Uma checagem lê a fonte duas vezes (a âncora e a posição); vinte mutações não viram vinte checagens.
      expect(measure.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("o comentário da citação só se grava com ação da pessoa", () => {
  it("fonte_fora_da_area_nao_grava: a fonte que rola para fora da tela (ainda no fio) não grava nem fecha o rascunho", async () => {
    const onSave = vi.fn(() => true);
    const onClose = vi.fn();
    await openWithDraft(onSave, onClose);
    sourceTop = 900;
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a posição do editor volta a acompanhar a fonte quando ela volta para a tela", () => {
  it("fonte_volta_para_a_tela_e_o_editor_retoma_a_posicao: sair da área visível não tira a fonte da âncora do editor", async () => {
    await openWithDraft(() => true, () => undefined);
    const editor = () => document.querySelector("textarea")!.closest("[style*='position: fixed']") as HTMLElement;
    const topWhileVisible = editor().style.top;
    // O fio rola: a fonte sai da área visível e volta.
    sourceTop = 900;
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    sourceTop = 120;
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expect(editor().style.top).toBe(topWhileVisible);
  });
});
