import { describe, expect, it } from "vitest";

import { chatInset, summaryFits, SUMMARY_GAP, SUMMARY_W } from "../summary/summaryLayout";

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
