import { describe, expect, it } from "vitest";
import { cdpModifiers, isGoogleSignIn, keyDownEvent, loginStartUrl, mouseButton, pageMetrics, pagePoint } from "../realBrowser";

describe("Chrome real: zoom da página", () => {
  it("150% = página com menos pixels CSS e mais densidade", () => {
    expect(pageMetrics({ width: 900, height: 600 }, 1.5, 1.25)).toEqual({ width: 600, height: 400, deviceScaleFactor: 3, mobile: false });
  });
  it("100% numa tela comum: o tamanho do Portal, desenhado a 2×", () => {
    expect(pageMetrics({ width: 1075, height: 639 }, 1, 1)).toEqual({ width: 1075, height: 639, deviceScaleFactor: 2, mobile: false });
  });
  it("tela de densidade maior que 2 não perde densidade", () => {
    expect(pageMetrics({ width: 1075, height: 639 }, 1, 2.5).deviceScaleFactor).toBe(2.5);
  });
  it("nó enorme: o teto de pixels baixa a densidade, mas nunca abaixo da da tela", () => {
    const m = pageMetrics({ width: 3000, height: 2000 }, 1, 1.25);
    expect(m.deviceScaleFactor).toBeLessThan(2);
    expect(m.deviceScaleFactor).toBeGreaterThanOrEqual(1.25);
    expect(pageMetrics({ width: 6000, height: 4000 }, 1, 1.25).deviceScaleFactor).toBe(1.25);
  });
});

describe("Chrome real: início do login", () => {
  it("começa pela raiz do site, nunca por um endereço de login vencido", () => {
    expect(loginStartUrl("https://accounts.google.com/v3/signin/identifier?continue=x&TL=abc")).toBe("https://accounts.google.com/");
    expect(loginStartUrl("github.com/login")).toBe("https://github.com/");
    expect(loginStartUrl("")).toBe("https://accounts.google.com/");
  });

  it("reconhece as páginas de login do Google, e só elas", () => {
    expect(isGoogleSignIn("https://accounts.google.com/v3/signin/identifier?continue=x")).toBe(true);
    expect(isGoogleSignIn("https://accounts.google.com/ServiceLogin?hl=pt")).toBe(true);
    expect(isGoogleSignIn("https://myaccount.google.com/")).toBe(false);
    expect(isGoogleSignIn("https://accounts.google.com/")).toBe(false);
  });
});

const key = (key: string, extra: Partial<{ code: string; keyCode: number; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  key, code: extra.code ?? "", keyCode: extra.keyCode ?? 0,
  altKey: false, ctrlKey: extra.ctrlKey ?? false, metaKey: false, shiftKey: extra.shiftKey ?? false,
});

describe("Chrome real: teclado", () => {
  it("caractere digitável vai com o texto, inclusive acentuado", () => {
    expect(keyDownEvent(key("a"))).toMatchObject({ type: "keyDown", text: "a" });
    expect(keyDownEvent(key("á"))).toMatchObject({ type: "keyDown", text: "á" });
    expect(keyDownEvent(key("@", { shiftKey: true }))).toMatchObject({ type: "keyDown", text: "@", modifiers: 8 });
  });

  it("Enter manda o \\r que envia formulários; Backspace vai cru", () => {
    expect(keyDownEvent(key("Enter", { keyCode: 13 }))).toMatchObject({ type: "keyDown", text: "\r" });
    expect(keyDownEvent(key("Backspace", { keyCode: 8 }))).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 8 });
  });

  it("Ctrl+V vira o comando de colar; tecla morta é ignorada", () => {
    expect(keyDownEvent(key("v", { ctrlKey: true }))).toMatchObject({ type: "rawKeyDown", commands: ["paste"], modifiers: 2 });
    expect(keyDownEvent(key("Dead"))).toBeNull();
  });
});

describe("Chrome real: mouse", () => {
  it("desfaz o tamanho com que o quadro aparece (zoom do canvas)", () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 };
    expect(pagePoint(420, 250, rect, { width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
  });

  it("botões e modificadores no formato do CDP", () => {
    expect(mouseButton(0)).toBe("left");
    expect(mouseButton(2)).toBe("right");
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(11);
  });
});
