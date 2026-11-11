import { describe, expect, it } from "vitest";

import { planDeviceReveal, revealFromShowFlag } from "../deviceReveal";

const base = {
  reveal: "default" as const,
  autoShowFloatingPreview: true,
  conversationOnScreen: true,
  panelShowsKind: false,
};

describe("aparelho que o agente abre sobre a conversa", () => {
  it("flutua quando a preferência de auto-show está ligada", () => {
    expect(planDeviceReveal(base)).toBe("float");
  });

  it("abre a aba do painel quando a preferência está desligada", () => {
    expect(planDeviceReveal({ ...base, autoShowFloatingPreview: false })).toBe("panel");
  });

  it("o agente pode forçar o flutuante mesmo com a preferência desligada", () => {
    expect(planDeviceReveal({ ...base, autoShowFloatingPreview: false, reveal: "force" })).toBe("float");
  });

  it("o agente pode pedir silêncio mesmo com a preferência ligada", () => {
    expect(planDeviceReveal({ ...base, reveal: "quiet" })).toBe("none");
    expect(planDeviceReveal({ ...base, reveal: "quiet", autoShowFloatingPreview: false })).toBe("none");
  });

  it("não mostra nada quando a conversa que abriu o aparelho não está à vista", () => {
    expect(planDeviceReveal({ ...base, conversationOnScreen: false, reveal: "force" })).toBe("none");
  });

  it("não duplica quando o painel já mostra a aba desse tipo de aparelho", () => {
    expect(planDeviceReveal({ ...base, panelShowsKind: true, reveal: "force" })).toBe("none");
  });
});

describe("flag `show` que o agente manda pela CLI ou pelo MCP", () => {
  it("sem a flag, vale a preferência", () => {
    expect(revealFromShowFlag(undefined)).toBe("default");
    expect(revealFromShowFlag(null)).toBe("default");
  });

  it("`show: true` força e `show: false` fica quieto; lixo cai no padrão", () => {
    expect(revealFromShowFlag(true)).toBe("force");
    expect(revealFromShowFlag(false)).toBe("quiet");
    expect(revealFromShowFlag("sim")).toBe("default");
  });
});
