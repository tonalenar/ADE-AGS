import { describe, expect, it } from "vitest";
import { cdpModifiers, isEchoOfReported, isGoogleSignIn, keyDownEvent, loginStartUrl, mouseButton, navigationKey, noteNavigation, RELOAD_LOOP, type Navigation, pageMetrics, pagePoint, rememberReported, REPORTED_URL_MS, shouldOpenInRealChrome } from "../realBrowser";

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

describe("shouldOpenInRealChrome", () => {
  it("site de fora abre no Chrome real; servidor local fica no proxy", () => {
    expect(shouldOpenInRealChrome("https://www.google.com/search?q=x", undefined)).toBe(true);
    expect(shouldOpenInRealChrome("https://gestaoautovale.com.br/mapa", undefined)).toBe(true);
    expect(shouldOpenInRealChrome("http://127.0.0.1:8790/mapa", undefined)).toBe(false);
    expect(shouldOpenInRealChrome("http://localhost:3000", undefined)).toBe(false);
    expect(shouldOpenInRealChrome("http://app.local/", undefined)).toBe(false);
  });
  it("a escolha explícita da pessoa sempre vale", () => {
    expect(shouldOpenInRealChrome("https://www.google.com", false)).toBe(false);
    expect(shouldOpenInRealChrome("http://localhost:3000", true)).toBe(true);
  });
  it("só http(s) conta", () => {
    expect(shouldOpenInRealChrome("about:blank", undefined)).toBe(false);
    expect(shouldOpenInRealChrome("file:///c:/x.html", undefined)).toBe(false);
  });
});

describe("eco das URLs que o Chrome informou", () => {
  it("a URL antiga de duas trocas seguidas (o Google depois do login) não faz o Portal navegar de volta", () => {
    const reported = new Map<string, number>();
    rememberReported(reported, "https://www.google.com/", 1_000);
    rememberReported(reported, "https://www.google.com/?zx=17931", 1_040);
    // A vista renderiza a primeira quando o Chrome já está na segunda: é eco, não endereço digitado.
    expect(isEchoOfReported(reported, "https://www.google.com/", 1_100)).toBe(true);
  });

  it("um endereço digitado depois da janela navega, mesmo que o Chrome já o tenha mostrado antes", () => {
    const reported = new Map<string, number>();
    rememberReported(reported, "https://www.google.com/", 1_000);
    expect(isEchoOfReported(reported, "https://www.google.com/", 1_000 + REPORTED_URL_MS)).toBe(false);
    expect(isEchoOfReported(reported, "https://example.com/", 1_100)).toBe(false);
  });

  it("guarda só as mais recentes", () => {
    const reported = new Map<string, number>();
    for (let i = 0; i < 5; i++) rememberReported(reported, `https://a/${i}`, i, 3);
    expect([...reported.keys()]).toEqual(["https://a/2", "https://a/3", "https://a/4"]);
  });
});

describe("laço de recarga da página", () => {
  const feed = (urls: string[], step: number, lastInput = 0, start = 1_000) => {
    const navs: Navigation[] = [];
    return urls.map((u, i) => noteNavigation(navs, u, start + i * step, lastInput));
  };
  const google = Array.from({ length: RELOAD_LOOP.count }, (_, i) => `https://www.google.com/?zx=${i}`);

  it("ignora a query: cada recarga do Google tem um zx novo", () => {
    expect(navigationKey("https://www.google.com/?zx=1#a")).toBe(navigationKey("https://www.google.com/?zx=2"));
    expect(navigationKey("https://www.google.com/search")).not.toBe(navigationKey("https://www.google.com/"));
  });

  it("acusa o laço só na N-ésima recarga seguida", () => {
    const hits = feed(google, 700);
    expect(hits.slice(0, -1).every((h) => !h)).toBe(true);
    expect(hits[hits.length - 1]).toBe(true);
  });

  it("um redirecionamento normal ou navegações espaçadas não são laço", () => {
    expect(feed(["https://a.com/", "https://accounts.google.com/x", "https://a.com/"], 200).some(Boolean)).toBe(false);
    expect(feed(google, RELOAD_LOOP.windowMs / (RELOAD_LOOP.count - 2)).some(Boolean)).toBe(false);
  });

  it("navegações depois de um clique ou tecla são da pessoa", () => {
    expect(feed(google, 700, 1_500).some(Boolean)).toBe(false);
  });
});
