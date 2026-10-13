import { describe, expect, it } from "vitest";

import { isFinalReport, memberFinished, POKE_PENDING_MS, pokeAllowed } from "../vigiaPoke";

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

describe("relatório final explícito", () => {
  it("pergunta e status de progresso não encerram a tarefa", () => {
    expect(isFinalReport("Backend iniciou: testes em execução.")).toBe(false);
    expect(isFinalReport("QA: informe o estado das propostas.", "ask")).toBe(false);
    expect(isFinalReport("Backend entregue? Preciso confirmar.")).toBe(false);
    expect(isFinalReport("Ainda não entregue: testes em execução.")).toBe(false);
    expect(isFinalReport("Use o marcador ENTREGUE na mensagem final.", "tell", "Backend")).toBe(false);
    expect(isFinalReport("G5: a primeira linha precisa conter ENTREGUE.", "tell", "Backend")).toBe(false);
    expect(isFinalReport("Backend: teste concluído, sigo trabalhando.")).toBe(false);
    expect(isFinalReport("Em progresso.\nEntrega final será depois dos testes.")).toBe(false);
  });

  it("entrega final explícita encerra só a tarefa anterior", () => {
    expect(isFinalReport("BACKEND ENTREGUE. Branch: cc/missao; commit: abc.", "tell", "Backend")).toBe(true);
    expect(isFinalReport("Frontend: trabalho concluído.", "tell", "Frontend")).toBe(true);
    expect(isFinalReport("Entrega final: relatório validado.")).toBe(true);
    expect(isFinalReport("QA / Tests v16 — ENTREGUE.", "tell", "QA / Tests")).toBe(true);
    expect(isFinalReport("Test[1]: ENTREGUE.", "tell", "Test[1]")).toBe(true);
    expect(isFinalReport("BACKEND ENTREGUE.", "ask")).toBe(false);
    expect(memberFinished(30, 20)).toBe(false);
  });
});
