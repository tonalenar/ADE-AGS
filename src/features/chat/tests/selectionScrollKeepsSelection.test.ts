// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeSelectionActions, type SelectionLike } from "../quotes/selectionModel";

// Um trecho selecionado no fio: a caixa do trecho é `top..top+20`, e o fio ocupa 0..600.
let top = 120;
let fio: HTMLElement;
const seleção = (): SelectionLike => ({
  isCollapsed: false,
  rangeCount: 1,
  anchorNode: null,
  focusNode: null,
  toString: () => "fala do agente",
  getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 10, top, right: 120, bottom: top + 20, width: 110, height: 20 }) }) as unknown as Range,
});

beforeEach(() => {
  top = 120;
  fio = document.createElement("div");
  document.body.appendChild(fio);
  vi.spyOn(fio, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 600, left: 0, right: 600, width: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  vi.spyOn(window, "getSelection").mockImplementation(() => seleção() as unknown as Selection);
});
afterEach(() => { fio.remove(); vi.restoreAllMocks(); });

describe("a rolagem sozinha não derruba a seleção que ainda está na tela", () => {
  it("scroll_com_trecho_visivel_nao_dispensa: o observador não dispensa a seleção enquanto o trecho está na tela", () => {
    const onDismiss = vi.fn();
    const actions = observeSelectionActions({ element: fio, onSelection: () => undefined, onDismiss });
    fio.dispatchEvent(new Event("scroll"));
    expect(onDismiss).not.toHaveBeenCalled();
    actions.dispose();
  });

  it("scroll_com_trecho_fora_da_tela_dispensa: quando o trecho sai da área visível, a pílula é dispensada", () => {
    const onDismiss = vi.fn();
    const actions = observeSelectionActions({ element: fio, onSelection: () => undefined, onDismiss });
    top = 900;
    fio.dispatchEvent(new Event("scroll"));
    expect(onDismiss).toHaveBeenCalledWith("cancel");
    actions.dispose();
  });
});
