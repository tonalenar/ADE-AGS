import { describe, expect, it } from "vitest";

import { memberFinished, POKE_PENDING_MS, pokeAllowed } from "../vigiaPoke";

const MIN = 60_000;

describe("quando o Vigia pode escrever no terminal", () => {
  it("nunca com o agente trabalhando", () => {
    expect(pokeAllowed(undefined, undefined, true, 0)).toBe(false);
    expect(pokeAllowed(0, 5 * MIN, true, 20 * MIN)).toBe(false);
  });

  it("a primeira vez passa", () => {
    expect(pokeAllowed(undefined, undefined, false, 0)).toBe(true);
  });

  it("uma cutucada sem resposta bloqueia a seguinte por 10 min", () => {
    expect(pokeAllowed(0, undefined, false, 4 * MIN)).toBe(false);
    expect(pokeAllowed(0, undefined, false, POKE_PENDING_MS - 1)).toBe(false);
    expect(pokeAllowed(0, undefined, false, POKE_PENDING_MS)).toBe(true);
  });

  it("depois que o agente respondeu, libera", () => {
    expect(pokeAllowed(0, 2 * MIN, false, 3 * MIN)).toBe(true);
    // Uma mensagem ANTERIOR à cutucada não é resposta.
    expect(pokeAllowed(5 * MIN, 2 * MIN, false, 6 * MIN)).toBe(false);
  });
});

describe("integrante que já entregou", () => {
  it("tarefa e relatório depois dela = terminou", () => {
    expect(memberFinished(10, 20)).toBe(true);
    expect(memberFinished(10, 10)).toBe(true);
  });

  it("sem tarefa, ou sem relatório depois dela, não terminou", () => {
    expect(memberFinished(undefined, 20)).toBe(false);
    expect(memberFinished(10, undefined)).toBe(false);
    expect(memberFinished(30, 20)).toBe(false);
  });
});
