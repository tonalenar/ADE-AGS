import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { offeredTarget, shouldAsk, withTarget } from "../routeSuggestion";

const team = [{ id: "1", name: "Orquestrador" }, { id: "2", name: "Backend" }, { id: "3", name: "QA" }];

describe("sugestão de destinatário na aba Equipe", () => {
  it("só pergunta com texto suficiente, sem @ e com ao menos dois destinos", () => {
    expect(shouldAsk("o endpoint de login está devolvendo 500", team)).toBe(true);
    expect(shouldAsk("oi", team)).toBe(false);
    expect(shouldAsk("@Backend arrume o login por favor", team)).toBe(false);
    expect(shouldAsk("o endpoint de login está devolvendo 500", [team[0]])).toBe(false);
  });

  it("oferece o integrante escolhido quando a probabilidade passa de 0,5", () => {
    expect(offeredTarget({ target: "backend", confidence: 0.2, probability: 0.8 }, team)).toEqual(team[1]);
    expect(offeredTarget({ target: "Backend", confidence: null, probability: null }, team)).toEqual(team[1]);
    expect(offeredTarget({ target: "Backend", confidence: 0.9, probability: 0.4 }, team)).toBeNull();
  });

  it("não oferece o orquestrador (é o padrão) nem quem não está na equipe", () => {
    expect(offeredTarget({ target: "orquestrador", confidence: 0.9, probability: 0.9 }, team)).toBeNull();
    expect(offeredTarget({ target: "Fantasma", confidence: 0.9, probability: 0.9 }, team)).toBeNull();
    expect(offeredTarget(null, team)).toBeNull();
  });

  it("o chip põe o @Nome no começo e limpa os espaços", () => {
    expect(withTarget("  login quebrado  ", team[1])).toBe("@Backend login quebrado");
  });
});
