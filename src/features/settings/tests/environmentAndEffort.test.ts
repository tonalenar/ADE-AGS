import { describe, expect, it } from "vitest";

import { effortBars } from "@/features/chat/effortBars";
import { environmentPill } from "@/features/settings/environmentIdentification";

describe("barras do esforço", () => {
  const levels = ["low", "medium", "high"];

  it("sem nível (o padrão) ou com um nível que o modelo não tem, não há barras", () => {
    expect(effortBars(null, levels)).toBeNull();
    expect(effortBars("max", levels)).toBeNull();
    expect(effortBars("low", [])).toBeNull();
  });

  it("o primeiro nível acende uma barra e o último acende todas", () => {
    expect(effortBars("low", levels)).toEqual({ lit: 1, total: 3 });
    expect(effortBars("medium", levels)).toEqual({ lit: 2, total: 3 });
    expect(effortBars("high", levels)).toEqual({ lit: 3, total: 3 });
  });
});

describe("selo do ambiente", () => {
  it("'nenhuma' nunca mostra selo, nem numa instalação de desenvolvimento", () => {
    expect(environmentPill("none", true)).toBeNull();
    expect(environmentPill("none", false)).toBeNull();
  });

  it("'automática' mostra selo só no desenvolvimento", () => {
    expect(environmentPill("auto", true)).toBe("development");
    expect(environmentPill("auto", false)).toBeNull();
  });

  it("'sempre' mostra o selo certo para cada instalação", () => {
    expect(environmentPill("pill", true)).toBe("development");
    expect(environmentPill("pill", false)).toBe("installed");
  });
});
