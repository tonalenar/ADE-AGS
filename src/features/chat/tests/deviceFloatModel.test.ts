import { describe, expect, it } from "vitest";

import { deviceFloatBox } from "../deviceFloatModel";

describe("retângulo do aparelho flutuante", () => {
  it("fica no canto de baixo à direita da conversa, com a mesma margem do navegador", () => {
    const box = deviceFloatBox({ left: 300, top: 40, width: 900, height: 700 });
    expect(box.left + box.width).toBe(300 + 900 - 18);
    expect(box.top + box.height).toBe(40 + 700 - 18);
  });

  it("usa uma fração da conversa, limitada entre 340 e 460 de largura e 360 e 560 de altura", () => {
    const huge = deviceFloatBox({ left: 0, top: 0, width: 2400, height: 1600 });
    expect(huge.width).toBe(460);
    expect(huge.height).toBe(560);
    const medium = deviceFloatBox({ left: 0, top: 0, width: 800, height: 700 });
    expect(medium.width).toBe(340);
    expect(medium.height).toBe(420);
  });

  it("em conversa baixa, o piso de 240 px de altura vence o encolhimento e o flutuante não sai da conversa pela largura", () => {
    const low = deviceFloatBox({ left: 0, top: 0, width: 420, height: 300 });
    expect(low.width).toBe(340);
    expect(low.height).toBe(240);
    expect(low.left).toBe(420 - 340 - 18);
    expect(low.top).toBe(300 - 240 - 18);
  });
});
