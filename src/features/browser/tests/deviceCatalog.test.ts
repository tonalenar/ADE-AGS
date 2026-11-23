import { describe, expect, it } from "vitest";

import {
  PHONE_MODELS, buttonPlacements, deviceHintOf, pageInsets, cutoutBox, defaultModel, frameThickness, insetsFor, modelFor, outerAspect,
} from "../deviceCatalog";

const byId = (id: string) => PHONE_MODELS.find((m) => m.id === id)!;

describe("catálogo único de aparelhos", () => {
  it("tem os modelos reais com as medidas do relatório", () => {
    expect(PHONE_MODELS.map((m) => m.id)).toEqual([
      "iphone-17-pro", "iphone-17-pro-max", "iphone-16", "pixel-9", "galaxy-s25", "galaxy-s25-ultra",
    ]);
    expect(byId("iphone-17-pro")).toMatchObject({ width: 402, height: 874, dpr: 3, radius: 62 });
    expect(byId("iphone-17-pro-max")).toMatchObject({ width: 440, height: 956, radius: 62 });
    expect(byId("iphone-16")).toMatchObject({ width: 393, height: 852, radius: 55 });
    expect(byId("pixel-9")).toMatchObject({ width: 412, height: 924, dpr: 2.625, radius: 46 });
    expect(byId("galaxy-s25")).toMatchObject({ width: 360, height: 780, dpr: 3, radius: 38 });
    expect(byId("galaxy-s25-ultra")).toMatchObject({ width: 412, height: 915, dpr: 3.5, radius: 20 });
    expect(new Set(PHONE_MODELS.map((m) => m.id)).size).toBe(PHONE_MODELS.length);
  });

  it("o padrão de cada sistema é o aparelho mais novo", () => {
    expect(defaultModel("ios").id).toBe("iphone-17-pro");
    expect(defaultModel("android").id).toBe("pixel-9");
  });

  it("acha o modelo pelo tamanho, em pé ou deitado, e cai no padrão do sistema", () => {
    expect(modelFor("ios", { width: 440, height: 956 }).id).toBe("iphone-17-pro-max");
    expect(modelFor("ios", { width: 956, height: 440 }).id).toBe("iphone-17-pro-max");
    expect(modelFor("android", { width: 360, height: 780 }).id).toBe("galaxy-s25");
    expect(modelFor("ios", { width: 333, height: 777 }).id).toBe("iphone-17-pro");
    expect(modelFor("android", { width: 333, height: 777 }).id).toBe("pixel-9");
    expect(modelFor("android", { width: 440, height: 956 }).id).toBe("pixel-9");
  });

  it("a área segura muda com a orientação (iPhone 17 Pro)", () => {
    expect(insetsFor(byId("iphone-17-pro"), false)).toEqual({ top: 62, bottom: 34, left: 0, right: 0 });
    expect(insetsFor(byId("iphone-17-pro"), true)).toEqual({ top: 0, bottom: 21, left: 62, right: 62 });
    expect(insetsFor(byId("iphone-16"), true)).toEqual({ top: 0, bottom: 21, left: 59, right: 59 });
  });

  it("a ilha vai para a lateral esquerda ao deitar, com o mesmo tamanho", () => {
    const m = byId("iphone-17-pro");
    expect(cutoutBox(m, false)).toEqual({ kind: "island", left: "50%", top: 11, width: 126, height: 37, translate: "-50% 0" });
    expect(cutoutBox(m, true)).toEqual({ kind: "island", left: 11, top: "50%", width: 37, height: 126, translate: "0 -50%" });
  });

  it("o furo do Android fica centrado no eixo da lateral ao deitar", () => {
    const m = byId("pixel-9");
    expect(cutoutBox(m, true)).toMatchObject({ kind: "punch", left: 14, top: "50%", width: 15, height: 15 });
    expect(cutoutBox(m, false)).toMatchObject({ kind: "punch", left: "50%", top: 14 });
  });

  it("a moldura é a mesma ao girar, porque vem dos pontos do modelo e não da largura", () => {
    const m = byId("iphone-17-pro");
    expect(frameThickness(m)).toBe(12);
  });

  it("a proporção do envelope do aparelho conta a moldura, em pé e deitado", () => {
    const portrait = outerAspect({ width: 402, height: 874 }, "ios");
    const landscape = outerAspect({ width: 874, height: 402 }, "ios");
    expect(portrait).toBeCloseTo((402 + 24) / (874 + 24), 5);
    expect(landscape).toBeCloseTo((874 + 24) / (402 + 24), 5);
    expect(portrait).toBeGreaterThan(402 / 874);
  });
});

describe("botões laterais com a quiralidade real", () => {
  it("iPhone em pé: ação e volumes à esquerda, liga/desliga à direita", () => {
    const p = buttonPlacements(byId("iphone-17-pro"), false);
    expect(p.filter((b) => b.edge === "left").map((b) => b.kind)).toEqual(["action", "volUp", "volDown"]);
    expect(p.filter((b) => b.edge === "right").map((b) => b.kind)).toEqual(["power"]);
  });

  it("iPhone deitado com a ilha à esquerda: ação e volumes embaixo, liga/desliga em cima", () => {
    const p = buttonPlacements(byId("iphone-17-pro"), true);
    expect(p.filter((b) => b.edge === "bottom").map((b) => b.kind)).toEqual(["action", "volUp", "volDown"]);
    expect(p.filter((b) => b.edge === "top").map((b) => b.kind)).toEqual(["power"]);
    expect(p.some((b) => b.edge === "left" || b.edge === "right")).toBe(false);
    // Da esquerda para a direita, na ordem de cima para baixo do aparelho em pé.
    const bottom = p.filter((b) => b.edge === "bottom").map((b) => b.start);
    expect([...bottom].sort((a, b) => a - b)).toEqual(bottom);
  });

  it("Pixel: tudo à direita em pé; deitado, tudo em cima com o liga/desliga mais à esquerda", () => {
    const portrait = buttonPlacements(byId("pixel-9"), false);
    expect(portrait.every((b) => b.edge === "right")).toBe(true);
    const land = buttonPlacements(byId("pixel-9"), true);
    expect(land.every((b) => b.edge === "top")).toBe(true);
    expect(land.map((b) => b.kind)).toEqual(["power", "volume"]);
  });

  it("Galaxy: deitado, o volume fica mais à esquerda e o liga/desliga mais à direita", () => {
    const land = buttonPlacements(byId("galaxy-s25"), true);
    expect(land.every((b) => b.edge === "top")).toBe(true);
    expect(land.map((b) => b.kind)).toEqual(["volume", "power"]);
  });

  it("a posição ao longo da borda é a mesma fração do lado maior nas duas orientações", () => {
    const m = byId("galaxy-s25-ultra");
    const a = buttonPlacements(m, false).map((b) => [b.kind, b.start, b.length]).sort();
    const b = buttonPlacements(m, true).map((x) => [x.kind, x.start, x.length]).sort();
    expect(b).toEqual(a);
  });
});

describe("o que o backend recebe do modelo", () => {
  it("a página do iPhone não repete a barra de status (vira margem) e ganha as laterais deitada", () => {
    expect(pageInsets(byId("iphone-17-pro"), false)).toEqual({ top: 0, bottom: 34, left: 0, right: 0 });
    expect(pageInsets(byId("iphone-17-pro"), true)).toEqual({ top: 0, bottom: 21, left: 62, right: 62 });
  });

  it("no Android o chrome e a faixa da câmera ficam fora da página", () => {
    expect(pageInsets(byId("pixel-9"), true)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("manda densidade, modelo do user agent e as duas áreas seguras", () => {
    expect(deviceHintOf(byId("galaxy-s25-ultra"))).toMatchObject({ dpr: 3.5, uaModel: "SM-S938B" });
    expect(deviceHintOf(byId("iphone-16")).safeLandscape.left).toBe(59);
  });
});
