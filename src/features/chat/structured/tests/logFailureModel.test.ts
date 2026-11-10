import { describe, expect, it } from "vitest";

import { addLogFailure, dismissLogFailure, logFailureReason, parseLogFailure } from "../logFailureModel";

// O sinal que `runs/execution_log.rs` (`fail_write`) manda à janela quando a gravação do log falha de vez.
const sinal = {
  scope: "chat",
  threadId: "t1",
  taskId: null,
  attemptId: null,
  eventType: "assistant",
  error: "disco cheio",
  attempts: 3,
  failureId: 7,
};

describe("parseLogFailure", () => {
  it("lê o sinal da conversa e usa o failureId como chave de dispensa", () => {
    expect(parseLogFailure(sinal)).toEqual({
      key: "id:7",
      threadId: "t1",
      eventType: "assistant",
      error: "disco cheio",
      attempts: 3,
    });
  });

  it("sem failureId (o registro também falhou), a chave é a assinatura do aviso", () => {
    expect(parseLogFailure({ ...sinal, failureId: null })?.key).toBe("sig:t1|assistant|disco cheio|3");
  });

  it("ignora a falha de tarefa da Frota, que não aparece na conversa", () => {
    expect(parseLogFailure({ ...sinal, threadId: null, taskId: "task-1" })).toBeNull();
  });

  it("ignora o que não é objeto ou não traz conversa", () => {
    expect(parseLogFailure(null)).toBeNull();
    expect(parseLogFailure("erro")).toBeNull();
    expect(parseLogFailure({ error: "sem conversa" })).toBeNull();
  });
});

describe("addLogFailure e dismissLogFailure", () => {
  it("não repete a mesma falha e tira só a que foi dispensada", () => {
    const primeira = parseLogFailure(sinal)!;
    const segunda = parseLogFailure({ ...sinal, failureId: 8 })!;
    const lista = addLogFailure(addLogFailure(addLogFailure([], primeira), primeira), segunda);
    expect(lista.map((f) => f.key)).toEqual(["id:7", "id:8"]);
    expect(dismissLogFailure(lista, "id:7").map((f) => f.key)).toEqual(["id:8"]);
  });
});

describe("logFailureReason", () => {
  it("junta as quebras e os espaços num texto de uma linha", () => {
    expect(logFailureReason("  linha 1\n\n linha   2 ")).toBe("linha 1 linha 2");
  });

  it("limita o motivo a 200 caracteres", () => {
    const curto = logFailureReason("x".repeat(500));
    expect(curto.length).toBeLessThanOrEqual(200);
    expect(curto.endsWith("…")).toBe(true);
  });
});
