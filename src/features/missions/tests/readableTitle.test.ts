import { describe, expect, it } from "vitest";

import { readableTitle, tailPath } from "../missionView";

describe("readableTitle", () => {
  it("suaviza um título em CAIXA ALTA, mantendo as siglas", () => {
    expect(readableTitle("CI: CARGO CHECK NO WINDOWS (EVITAR QUEBRA SO-WINDOWS PASSAR)"))
      .toBe("CI: cargo check no windows (evitar quebra so-windows passar)");
    expect(readableTitle("ETAPA 25 - MEMORIA: TELAS PENDENTES")).toBe("Etapa 25 - memoria: telas pendentes");
  });
  it("não mexe num título em caixa mista", () => {
    expect(readableTitle("Etapa 24 - Memoria: ler pelo indice")).toBe("Etapa 24 - Memoria: ler pelo indice");
    expect(readableTitle("Polir o bot - aura e acabamento")).toBe("Polir o bot - aura e acabamento");
  });
  it("não mexe em títulos curtos ou só de siglas", () => {
    expect(readableTitle("CI")).toBe("CI");
    expect(readableTitle("")).toBe("");
  });
  it("capitaliza a primeira letra depois de um número ou símbolo", () => {
    expect(readableTitle("25 - TELAS PENDENTES DA MEMORIA")).toBe("25 - Telas pendentes da memoria");
  });
});

describe("tailPath", () => {
  it("guarda só os dois últimos trechos", () => {
    expect(tailPath(String.raw`C:\Users\tonz1n\.antigravity\ADE-AGS`)).toBe("…/.antigravity/ADE-AGS");
    expect(tailPath("/home/a/projeto")).toBe("…/a/projeto");
  });
  it("caminho curto fica como está", () => {
    expect(tailPath(String.raw`C:\ADE-AGS`)).toBe("C:/ADE-AGS");
    expect(tailPath("")).toBe("");
  });
});
