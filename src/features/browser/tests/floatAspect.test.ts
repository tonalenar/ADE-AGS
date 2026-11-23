import { describe, expect, it } from "vitest";

import { floatAspectRatioOf } from "../deviceMode";
import { FILL_VIEWPORT } from "../viewport";

describe("proporção da miniatura flutuante", () => {
  it("celular: conta a moldura dos dois lados, para o aparelho encaixar justo", () => {
    expect(floatAspectRatioOf({ width: 402, height: 874 }, "ios")).toBeCloseTo((402 + 24) / (874 + 24), 5);
    expect(floatAspectRatioOf({ width: 412, height: 924 }, "android")).toBeCloseTo((412 + 24) / (924 + 24), 5);
  });

  it("deitado é o inverso exato do em pé", () => {
    const portrait = floatAspectRatioOf({ width: 402, height: 874 }, "ios")!;
    const landscape = floatAspectRatioOf({ width: 874, height: 402 }, "ios")!;
    expect(landscape).toBeCloseTo(1 / portrait, 5);
  });

  it("tablet e desktop emoldurados seguem a proporção da tela; sem moldura, livre", () => {
    expect(floatAspectRatioOf({ width: 768, height: 1024 })).toBeCloseTo(768 / 1024, 5);
    expect(floatAspectRatioOf(FILL_VIEWPORT)).toBeNull();
    expect(floatAspectRatioOf(null)).toBeNull();
  });
});
