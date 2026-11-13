import { describe, expect, it } from "vitest";
import { clampFloatRect, dragFloatRect } from "../floatRect";
import { placeChatBrowserFloat, setChatBrowser, toggleChatBrowserFloating, useChatStore } from "../store";

const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };

describe("miniatura do navegador: mover e redimensionar", () => {
  it("prende a miniatura dentro da conversa", () => {
    expect(clampFloatRect({ left: -50, top: 0, width: 400, height: 300 }, bounds)).toEqual({ left: 8, top: 8, width: 400, height: 300 });
    expect(clampFloatRect({ left: 900, top: 700, width: 400, height: 300 }, bounds)).toEqual({ left: 592, top: 492, width: 400, height: 300 });
  });

  it("sem lados move; com lados redimensiona e o lado oposto fica parado", () => {
    const start = { left: 500, top: 400, width: 400, height: 300 };
    expect(dragFloatRect(start, {}, -100, -50, bounds)).toEqual({ left: 400, top: 350, width: 400, height: 300 });
    expect(dragFloatRect(start, { left: true, top: true }, -100, -50, bounds)).toEqual({ left: 400, top: 350, width: 500, height: 350 });
    expect(dragFloatRect(start, { right: true, bottom: true }, 50, 40, bounds)).toEqual({ left: 500, top: 400, width: 450, height: 340 });
    expect(dragFloatRect(start, { right: true }, -1000, 0, bounds).width).toBe(220);
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
