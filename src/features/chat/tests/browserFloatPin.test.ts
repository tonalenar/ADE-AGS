import { describe, expect, it } from "vitest";
import { clampFloatRect, defaultFloatRect, dragFloatRect, fitFloatRectToRatio } from "../floatRect";
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

  it("ao recolher em modo aparelho, nasce com a proporção do celular e folga para a dock", () => {
    const iphoneRatio = 390 / 844;
    const rect = defaultFloatRect(bounds, { aspectRatio: iphoneRatio });
    expect(rect.height).toBeGreaterThan(rect.width);
    expect(Math.abs(rect.width / rect.height - iphoneRatio)).toBeLessThan(0.02);
    expect(bounds.bottom - (rect.top + rect.height)).toBeGreaterThanOrEqual(40);
  });

  it("redimensionar com proporção ativa trava o aspecto em bordas e cantos", () => {
    const ratio = 390 / 844;
    const start = { left: 600, top: 200, width: 234, height: 506 };
    const fromCorner = dragFloatRect(start, { right: true, bottom: true }, 40, 86, bounds, ratio);
    expect(Math.abs(fromCorner.width / fromCorner.height - ratio)).toBeLessThan(0.02);
    expect(fromCorner.left).toBe(600);
    expect(fromCorner.top).toBe(200);

    const fromRight = dragFloatRect(start, { right: true }, 60, 0, bounds, ratio);
    expect(Math.abs(fromRight.width / fromRight.height - ratio)).toBeLessThan(0.02);

    const fromLeftTop = dragFloatRect(start, { left: true, top: true }, -30, -65, bounds, ratio);
    expect(Math.abs(fromLeftTop.width / fromLeftTop.height - ratio)).toBeLessThan(0.02);
    expect(fromLeftTop.left + fromLeftTop.width).toBe(start.left + start.width);
    expect(fromLeftTop.top + fromLeftTop.height).toBe(start.top + start.height);
  });

  it("ao girar a miniatura já posicionada, ajusta para a nova proporção dentro dos limites", () => {
    const portrait = { left: 400, top: 150, width: 220, height: 476 };
    const rotated = fitFloatRectToRatio(portrait, bounds, 844 / 390);
    expect(rotated.width).toBeGreaterThan(rotated.height);
    expect(Math.abs(rotated.width / rotated.height - 844 / 390)).toBeLessThan(0.03);
    expect(rotated.left).toBeGreaterThanOrEqual(8);
    expect(rotated.top).toBeGreaterThanOrEqual(8);
  });
});
