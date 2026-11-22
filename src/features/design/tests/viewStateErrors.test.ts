import { describe, expect, it } from "vitest";

import { VIEW_LIMITS, buildViewState } from "../viewState";

const base = {
  mode: "canvas" as const,
  page: { id: "p1", name: "Página 1" },
  boards: [],
  camera: { x: 0, y: 0, scale: 1 },
  viewport: { width: 800, height: 600, top: 0 },
  focusedId: null,
  selectedIds: [],
  picked: [],
  now: 1,
};

describe("view state leva os últimos erros de script das pranchetas", () => {
  it("manda no máximo 3 erros, os mais recentes, com a mensagem cortada para caber no orçamento do agente", () => {
    const errors = Array.from({ length: 5 }, (_, i) => ({ artboardId: `b${i}`, title: "Tela", message: "x".repeat(400) }));
    const state = buildViewState({ ...base, errors });
    expect(VIEW_LIMITS.errors).toBe(3);
    expect(state.lastErrors.map((e) => e.artboardId)).toEqual(["b2", "b3", "b4"]);
    expect(state.lastErrors[0].message).toHaveLength(VIEW_LIMITS.errorMessage);
    expect(state.lastErrors[0].title).toBe("Tela");
  });

  it("sem erro, a lista vem vazia", () => {
    expect(buildViewState(base).lastErrors).toEqual([]);
  });
});
