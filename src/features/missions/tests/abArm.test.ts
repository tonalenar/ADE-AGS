import { describe, expect, it } from "vitest";

import { isMemoryOff, parseAbArm, priorContext } from "../abArm";

describe("braço do teste A/B no título da missão", () => {
  it("lê grupo e braço do marcador no começo do título", () => {
    expect(parseAbArm("[AB:Mem-1:Sem-Memoria] corrigir o login")).toEqual({ group: "mem-1", arm: "sem-memoria" });
    expect(parseAbArm("  [AB:g:solo] x")).toEqual({ group: "g", arm: "solo" });
  });

  it("sem marcador, ou com o marcador fora do começo, é uma missão normal", () => {
    expect(parseAbArm("corrigir o login")).toBeNull();
    expect(parseAbArm("corrigir [AB:g:sem-memoria]")).toBeNull();
    expect(parseAbArm("[AB::x] y")).toBeNull();
    expect(isMemoryOff("corrigir o login")).toBe(false);
  });

  it("só o braço sem-memoria tira a memória e o resumo de missões anteriores do briefing", () => {
    const prepared = { precheck: "achados antigos", memory: "- decisão" };
    expect(priorContext("[AB:g:sem-memoria] t", prepared)).toEqual({ findings: "", memory: "" });
    expect(priorContext("[AB:g:com-memoria] t", prepared)).toEqual({ findings: "achados antigos", memory: "- decisão" });
    expect(priorContext("[AB:g:solo] t", prepared)).toEqual({ findings: "achados antigos", memory: "- decisão" });
    expect(priorContext("t", prepared)).toEqual({ findings: "achados antigos", memory: "- decisão" });
  });
});
