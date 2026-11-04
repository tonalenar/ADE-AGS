import { describe, expect, it } from "vitest";

import { chatInset, summaryFits, summaryPlacement, SUMMARY_GAP, SUMMARY_W } from "../summary/summaryLayout";

describe("o Resumo solto ao lado do chat", () => {
  it("cabe quando sobra a largura mínima da conversa (520) além dos cartões", () => {
    expect(summaryFits(520 + SUMMARY_W + SUMMARY_GAP)).toBe(true);
    expect(summaryFits(520 + SUMMARY_W + SUMMARY_GAP - 1)).toBe(false);
    expect(summaryFits(440)).toBe(false);
  });
  it("sem medida ainda, cabe (a primeira pintura não pisca)", () => {
    expect(summaryFits(null)).toBe(true);
    expect(summaryFits(Number.NaN)).toBe(true);
  });
  it("a conversa só cede espaço com o Resumo à vista e com lugar", () => {
    expect(chatInset("summary", 1200)).toBe(SUMMARY_W + SUMMARY_GAP);
    expect(chatInset("summary", 700)).toBe(0);
    expect(chatInset("diff", 1200)).toBe(0);
    expect(chatInset(null, 1200)).toBe(0);
  });
});

describe("onde o Resumo aparece (nunca some com o botão ligado)", () => {
  it("com lugar, ao lado da conversa (solto)", () => {
    expect(summaryPlacement("summary", 1200)).toBe("beside");
  });

  it("sem lugar, por cima da conversa (antes ele sumia e o botão ficava marcado, sem painel nenhum)", () => {
    expect(summaryPlacement("summary", 700)).toBe("overlay");
    expect(summaryPlacement("summary", 440)).toBe("overlay");
  });

  it("outra superfície, ou o painel fechado, não mostra o Resumo", () => {
    expect(summaryPlacement("diff", 1200)).toBe("none");
    expect(summaryPlacement("team", 700)).toBe("none");
    expect(summaryPlacement(null, 1200)).toBe("none");
  });

  it("sem medida ainda, ao lado (a primeira pintura não pisca)", () => {
    expect(summaryPlacement("summary", null)).toBe("beside");
  });
});

