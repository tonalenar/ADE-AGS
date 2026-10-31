import { describe, expect, it } from "vitest";

import { fitScale } from "@/features/chat/DevicesPane";
import { phoneOf } from "@/features/simulator/geometry";

const iphone = { width: 402, height: 874, family: "iphone" as const };

describe("fitScale (o aparelho no painel direito)", () => {
  it("o aparelho com a moldura cabe na caixa", () => {
    const box = { w: 500, h: 700 };
    const phone = phoneOf(iphone, fitScale(iphone, box));
    expect(phone.w).toBeLessThanOrEqual(box.w + 0.01);
    expect(phone.h).toBeLessThanOrEqual(box.h + 0.01);
  });

  it("numa caixa enorme não passa do tamanho máximo", () => {
    expect(fitScale(iphone, { w: 10000, h: 10000 })).toBe(1.2);
  });

  it("sem caixa (ainda não medida) a escala é zero", () => {
    expect(fitScale(iphone, { w: 0, h: 600 })).toBe(0);
  });
});
