import { describe, expect, it } from "vitest";

import { numberedPoints, splitObjective } from "../objectiveFormat";

const SAMPLE =
  "ETAPA 24 - MEMORIA: LER PELO INDICE. Continuacao da Etapa 23 (ja no master). PONTOS: (1) LEITURA POR INDICE (M3, Fase 2): hoje o snapshot despeja 16 KiB. " +
  "(2) TERMINAIS (M5, M6): o briefing injeta texto cru. (3) PASTA DE ENXAME COM ESCRITA LIVRE: swarms/<missao>/findings.md. " +
  "REGRAS: trabalhe em worktrees novos. DELEGACAO: o Orquestrador delega nos primeiros minutos.";

describe("splitObjective", () => {
  it("separa introdução, pontos numerados e seções sem número", () => {
    const parts = splitObjective(SAMPLE);
    expect(parts.intro).toContain("ETAPA 24");
    expect(parts.intro).toContain("Continuacao da Etapa 23");
    expect(numberedPoints(parts).map((p) => [p.n, p.label])).toEqual([
      [1, "Leitura por indice (M3, Fase 2)"],
      [2, "Terminais (M5, M6)"],
      [3, "Pasta de enxame com escrita livre"],
    ]);
    expect(parts.sections.map((s) => s.label)).toContain("Regras");
    expect(parts.sections.map((s) => s.label)).not.toContain("Pontos");
    expect(parts.sections.find((s) => s.n === 2)?.body).toBe("o briefing injeta texto cru.");
  });

  it("não perde nem duplica texto: cada parte começa onde a anterior termina", () => {
    const parts = splitObjective(SAMPLE);
    const rebuilt = [parts.intro, ...parts.sections.map((s) => s.body)].join(" ");
    for (const word of ["snapshot", "swarms/<missao>/findings.md", "worktrees novos", "primeiros minutos"]) {
      expect(rebuilt.split(word).length - 1).toBe(1);
    }
  });

  it("texto curto ou sem títulos volta inteiro como introdução", () => {
    expect(splitObjective("Corrigir o bug do botão de salvar.")).toEqual({ intro: "Corrigir o bug do botão de salvar.", sections: [] });
    expect(splitObjective("Um objetivo normal: com dois pontos no meio, mas sem títulos em maiúsculas.").sections).toEqual([]);
  });

  it("um único título não vira lista (precisa de pelo menos dois)", () => {
    expect(splitObjective("Faça isto. REGRAS: não mexa em nada.").sections).toEqual([]);
  });

  it("ignora quebras de linha do Windows", () => {
    const parts = splitObjective("INTRO TEXTO AQUI.\r\n(1) PRIMEIRO PONTO: a. (2) SEGUNDO PONTO: b.");
    expect(numberedPoints(parts)).toHaveLength(2);
  });
});
