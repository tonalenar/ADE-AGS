import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";
import { fixRoundCaption, maxFixRound } from "../fixRounds";

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });
  } else {
    await i18n.changeLanguage("pt-BR");
  }
});

describe("rodadas de correção na telemetria", () => {
  it("mostra a maior rodada usada e ignora outros spans", () => {
    const n = maxFixRound([
      { kind: "turn", detail: "n=9" },
      { kind: "fix_round", detail: "n=1;full=0;escalated=0;key=api" },
      { kind: "fix_round", detail: "n=2;full=1;escalated=1;key=api" },
    ]);
    expect(n).toBe(2);
  });

  it("não inventa rodada quando a missão não corrigiu nada", () => {
    expect(maxFixRound([{ kind: "test", detail: "" }])).toBeNull();
  });

  it("a última rodada deixa o gate completo visível", () => {
    expect(fixRoundCaption(2, true)).toContain("gate completo");
    expect(fixRoundCaption(1, false)).toBe("correção 1");
  });
});
