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

describe("relatório final ao Orquestrador (sem marcador)", () => {
  const report = "Relatório Final de QA — Missão Melhoria da Memória.\n1. Cache de testes: mesma árvore em 2 worktrees, hash igual; 'já verde neste hash'.\n2. Fluxo de memória pelo CLI sem achados. Smoke 9/9.";
  it("um tell com corpo de relatório ao Orquestrador entrega a tarefa, mesmo sem ENTREGUE na primeira linha", () => {
    expect(isFinalReport(report, "tell", "QA / Tests", true)).toBe(true);
    expect(isFinalReport("Backend: corrigi A1 e A2 em src-tauri/src/memory.rs, commit 4f1a2b3, ags test run rust verde (1378 passaram), sem pendências.", "tell", "Backend", true)).toBe(true);
  });
  it("a mesma mensagem a outro integrante não é entrega", () => {
    expect(isFinalReport(report, "tell", "QA / Tests", false)).toBe(false);
  });
  it("recebi, andamento, pergunta e mensagem curta ao Orquestrador não entregam", () => {
    expect(isFinalReport("Recebido. Iniciando a tarefa agora; volto com o relatório quando terminar os testes e a revisão.", "tell", "Backend", true)).toBe(false);
    expect(isFinalReport("Em progresso: rodando a suíte, ainda sem resultado para reportar ao Orquestrador neste momento.", "tell", "Backend", true)).toBe(false);
    expect(isFinalReport("Posso mexer no schema para o item M2? Preciso saber antes de continuar com a correção da quota de memória.", "tell", "Backend", true)).toBe(false);
    expect(isFinalReport("Pronto.", "tell", "Backend", true)).toBe(false);
    expect(isFinalReport(report, "ask", "QA / Tests", true)).toBe(false);
  });
});

describe("andamento com o nome na frente não é entrega (v19 B1)", () => {
  it("'Backend: em andamento…' ao Orquestrador não conta; o relatório com o nome na frente conta", () => {
    expect(isFinalReport("Backend: em andamento. Vou executar as suítes e ler o banco; resultados ainda pendentes, nenhum relatório final disponível.", "tell", "Backend", true)).toBe(false);
    expect(isFinalReport("Backend: recebido, começando agora; volto com o resultado completo dos testes e dos arquivos quando terminar a rodada de leitura.", "tell", "Backend", true)).toBe(false);
    expect(isFinalReport("Backend: corrigi A1 em src-tauri/src/memory.rs, commit 4f1a2b3, ags test run rust verde (1378 passaram), sem pendências.", "tell", "Backend", true)).toBe(true);
  });
});
