import { describe, expect, it } from "vitest";

import { progressReport, withProgress } from "../actProgress";
import type { PilotDeps } from "../jevPilot";

function fakeDeps(over: Partial<PilotDeps> = {}): PilotDeps {
  return {
    snapshot: async () => "page: Loja\n@e1 button Comprar",
    click: async () => "ok",
    type: async () => "ok",
    select: async () => "ok",
    scroll: async () => "ok",
    settle: async () => {},
    pick: async () => { throw new Error("não usado"); },
    ...over,
  };
}

describe("progresso parcial do act (1.4)", () => {
  it("cada ação concluída vira uma linha e o relatório leva o começo da última página", async () => {
    const reports: string[] = [];
    const deps = withProgress(fakeDeps(), (r) => reports.push(r));
    await deps.snapshot();
    await deps.type("@e2", "tênis", true);
    await deps.click("@e5");
    expect(reports).toHaveLength(2);
    const last = reports[1];
    expect(last).toContain("1. digitou em @e2 (5 caracteres, com Enter)");
    expect(last).toContain("2. clicou @e5");
    expect(last).toContain("@e1 button Comprar");
  });

  it("uma ação que falhou não conta como feita", async () => {
    const reports: string[] = [];
    const deps = withProgress(fakeDeps({ click: async () => { throw new Error("A página não respondeu em 12 s."); } }), (r) => reports.push(r));
    await expect(deps.click("@e1")).rejects.toThrow("12 s");
    expect(reports).toEqual([]);
  });

  it("um sink que lança nunca derruba o act", async () => {
    const deps = withProgress(fakeDeps(), () => { throw new Error("sem backend"); });
    await expect(deps.scroll()).resolves.toBe("ok");
  });

  it("sem ações não há relatório; página longa é cortada", () => {
    expect(progressReport([], "x")).toBe("");
    const r = progressReport(["1. clicou @e1"], "a".repeat(5000));
    expect(r.length).toBeLessThan(1800);
    expect(r.endsWith("…")).toBe(true);
  });
});
