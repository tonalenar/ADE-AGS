import { describe, expect, it } from "vitest";
import { clampFloatRect, FLOAT_BAR, resizeFromTopLeft } from "../floatRect";
import { placeChatBrowserFloat, setChatBrowser, toggleChatBrowserFloating, useChatStore } from "../store";

const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };

describe("miniatura do navegador: mover e redimensionar", () => {
  it("prende a miniatura e a faixa de arrastar dentro da conversa", () => {
    expect(clampFloatRect({ left: -50, top: 0, width: 400, height: 300 }, bounds)).toEqual({ left: 8, top: 8 + FLOAT_BAR, width: 400, height: 300 });
    expect(clampFloatRect({ left: 900, top: 700, width: 400, height: 300 }, bounds)).toEqual({ left: 592, top: 492, width: 400, height: 300 });
  });

  it("redimensiona pelo canto superior esquerdo mantendo o inferior direito", () => {
    const r = resizeFromTopLeft({ left: 500, top: 400, width: 400, height: 300 }, -100, -50, bounds);
    expect(r).toEqual({ left: 400, top: 350, width: 500, height: 350 });
    expect(r.left + r.width).toBe(900);
    expect(resizeFromTopLeft({ left: 500, top: 400, width: 400, height: 300 }, 1000, 1000, bounds).width).toBeGreaterThanOrEqual(220);
  });

  it("depois de mover, guarda a posição e marca para não reancorar; recolher de novo esquece", () => {
    useChatStore.setState({ browser: null, browserFloating: false, browserFloatRect: null, browserFloatPinned: false });
    setChatBrowser({ viewId: "v1", rect: { left: 0, top: 0, width: 500, height: 400 } });
    toggleChatBrowserFloating();
    placeChatBrowserFloat({ left: 40, top: 60, width: 300, height: 200 });
    expect(useChatStore.getState()).toMatchObject({ browserFloatPinned: true, browserFloatRect: { left: 40, top: 60, width: 300, height: 200 } });
    toggleChatBrowserFloating();
    expect(useChatStore.getState().browserFloatPinned).toBe(false);
  });
});
