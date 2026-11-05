import { describe, expect, it } from "vitest";

import { panelColumnWidth, SUMMARY_W } from "../summary/summaryLayout";

describe("onde o Resumo fica", () => {
  it("é a aba do painel direito com largura fixa; as outras superfícies usam a largura arrastada", () => {
    expect(panelColumnWidth("summary", 720)).toBe(SUMMARY_W);
    expect(panelColumnWidth("ios", 720)).toBe(720);
    expect(panelColumnWidth("browser", 540)).toBe(540);
    // Cabem os cartões (320 px) com a margem do painel.
    expect(SUMMARY_W).toBeGreaterThanOrEqual(320);
  });
});
