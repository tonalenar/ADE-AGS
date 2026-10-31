import { describe, expect, it } from "vitest";

import { androidLabel, deviceFrame, iosLabel, parseCoord, sharedDevices } from "@/features/chat/devicesModel";
import { appendMention } from "@/features/chat/ChatComposer";

describe("moldura dos aparelhos do painel (pranchetas 9 e 10)", () => {
  it("a altura da prancheta dá as medidas dela: iPhone 300×620, moldura 10, cantos 52", () => {
    const f = deviceFrame("ios", { w: 280, h: 600 }, { w: 1000, h: 620 }, 620);
    expect(f.outerW).toBeCloseTo(300, 0);
    expect(f.outerH).toBeCloseTo(620, 0);
    expect(f.pad).toBeCloseTo(10, 0);
    expect(f.outerRadius).toBeCloseTo(52, 0);
    expect(f.screenRadius).toBeCloseTo(42, 0);
  });

  it("caixa estreita: a largura manda", () => {
    const f = deviceFrame("android", { w: 1080, h: 2424 }, { w: 200, h: 900 });
    expect(f.outerW).toBeLessThanOrEqual(200);
    expect(f.outerH).toBeLessThan(900);
  });

  it("sem espaço ou sem tela, nada", () => {
    expect(deviceFrame("ios", { w: 402, h: 874 }, { w: 0, h: 500 }).outerW).toBe(0);
    expect(deviceFrame("ios", { w: 0, h: 0 }, { w: 400, h: 500 }).outerH).toBe(0);
  });
});

describe("rótulos", () => {
  const words = { emulator: "emulador", usb: "USB" };
  it("emulador com a API; telefone pelo USB", () => {
    expect(androidLabel({ model: "Pixel 9", api: 36, emulator: true }, words)).toBe("Pixel 9 · API 36 · emulador");
    expect(androidLabel({ model: "Galaxy S25", api: 35, emulator: false }, words)).toBe("Galaxy S25 · USB");
    expect(androidLabel({ model: "", api: null, emulator: true }, words)).toBe("Android · emulador");
  });
  it("iOS com o sistema", () => {
    expect(iosLabel("iPhone 18 Pro", "iOS 26")).toBe("iPhone 18 Pro · iOS 26");
    expect(iosLabel("iPhone 18 Pro", "")).toBe("iPhone 18 Pro");
  });
});

describe("coordenadas digitadas", () => {
  it("aceita vírgula e respeita os limites", () => {
    expect(parseCoord("-23,55", 90)).toBeCloseTo(-23.55);
    expect(parseCoord("181", 180)).toBeNull();
    expect(parseCoord("", 90)).toBeNull();
    expect(parseCoord("abc", 90)).toBeNull();
  });
});

describe("aparelhos que os agentes alcançam", () => {
  it("só os de abas abertas e com aparelho escolhido", () => {
    const names = { ios: "iPhone 17", android: "Pixel 9" };
    expect(sharedDevices(["browser", "ios"], { ios: "U1", android: "emulator-5554" }, names))
      .toEqual([{ kind: "ios", name: "iPhone 17", udid: "U1" }]);
    expect(sharedDevices(["ios", "android"], { ios: null, android: "emulator-5554" }, names))
      .toEqual([{ kind: "android", name: "Pixel 9", serial: "emulator-5554" }]);
    expect(sharedDevices(["files"], { ios: "U1", android: null }, names)).toEqual([]);
  });
});

describe("captura no composer", () => {
  it("entra no fim, separada por espaço", () => {
    expect(appendMention("", "@/tmp/a.png")).toBe("@/tmp/a.png ");
    expect(appendMention("olha", "@/tmp/a.png")).toBe("olha @/tmp/a.png ");
    expect(appendMention("olha ", "@/tmp/a.png")).toBe("olha @/tmp/a.png ");
  });
});
