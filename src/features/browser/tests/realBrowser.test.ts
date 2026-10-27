import { describe, expect, it } from "vitest";
import { intersect, placeOf, relativeTo, samePlace, shouldOpenInRealChrome } from "../realBrowser";

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

describe("lugar do navegador nativo no Portal", () => {
  const portal = { x: 100, y: 50, width: 800, height: 600 };
  const window = { x: 0, y: 0, width: 1920, height: 1080 };

  it("interseção e coordenadas relativas", () => {
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
    expect(relativeTo({ x: 150, y: 80, width: 10, height: 10 }, portal)).toEqual({ x: 50, y: 30, width: 10, height: 10 });
  });

  it("à vista e sem nada por cima: a página inteira aparece", () => {
    const place = placeOf(portal, 800, 1, [window], [], true);
    expect(place.visible).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(place.holes).toEqual([]);
    expect(place.zoom).toBe(1);
  });

  it("o zoom da página acompanha o zoom do canvas", () => {
    // No canvas a 50% o Portal de 800 px de layout ocupa 400 px na tela.
    expect(placeOf({ ...portal, width: 400, height: 300 }, 800, 1, [window], [], true).zoom).toBe(0.5);
    expect(placeOf({ ...portal, width: 400, height: 300 }, 800, 1.25, [window], [], true).zoom).toBe(0.625);
  });

  it("o que passa da borda do canvas é cortado", () => {
    const canvas = { x: 0, y: 0, width: 600, height: 400 };
    expect(placeOf(portal, 800, 1, [window, canvas], [], true).visible).toEqual({ x: 0, y: 0, width: 500, height: 350 });
  });

  it("um menu por cima vira buraco, só a parte dele dentro do Portal", () => {
    const menu = { x: 850, y: 40, width: 200, height: 100 };
    expect(placeOf(portal, 800, 1, [window], [menu], true).holes).toEqual([{ x: 750, y: 0, width: 50, height: 90 }]);
  });

  it("fora de vista nada aparece", () => {
    const place = placeOf(portal, 800, 1, [window], [{ x: 0, y: 0, width: 10, height: 10 }], false);
    expect(place.visible).toBeNull();
    expect(place.holes).toEqual([]);
  });

  it("só manda de novo quando algo mudou", () => {
    const a = placeOf(portal, 800, 1, [window], [], true);
    expect(samePlace(a, placeOf(portal, 800, 1, [window], [], true))).toBe(true);
    expect(samePlace(a, placeOf({ ...portal, x: 101 }, 800, 1, [window], [], true))).toBe(false);
    expect(samePlace(null, a)).toBe(false);
  });
});
