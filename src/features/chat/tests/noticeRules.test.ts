import { describe, expect, it } from "vitest";

import { noticesBetween, noticeStatesOf, type NoticeState } from "@/features/chat/noticeRules";
import type { ThreadLive } from "@/features/chat/structured/model";
import type { RequestRow } from "@/features/chat/structured/ipc";

const idle: NoticeState = { phase: "idle", awaiting: false, question: false, failed: false };
const working: NoticeState = { ...idle, phase: "working" };

const request = (kind: "command" | "question", state: "pending" | "answered"): RequestRow =>
  ({ id: `${kind}-${state}`, threadId: "t1", kind, state }) as unknown as RequestRow;

const hilo = (patch: Partial<ThreadLive>): ThreadLive => ({
  items: [], requests: [], phase: "idle", drafts: [], error: null, providerCommands: [], providerConfig: null, ...patch,
});

describe("avisos no app: o que virou entre dois estados", () => {
  it("uma conversa que para de trabalhar avisa que terminou", () => {
    const out = noticesBetween({ a: working }, { a: idle }, null);
    expect(out).toEqual([{ ref: "a", kind: "done" }]);
  });

  it("estado parado que não mudou não avisa de novo", () => {
    expect(noticesBetween({ a: idle }, { a: idle }, null)).toEqual([]);
    expect(noticesBetween({ a: working }, { a: working }, null)).toEqual([]);
  });

  it("a conversa à vista não avisa, mesmo que termine", () => {
    expect(noticesBetween({ a: working, b: working }, { a: idle, b: idle }, "a")).toEqual([{ ref: "b", kind: "done" }]);
  });

  it("conversa que aparece pela primeira vez entra sem aviso", () => {
    expect(noticesBetween({}, { a: { ...idle, awaiting: true } }, null)).toEqual([]);
  });

  it("aprovação pedida avisa, e não repete enquanto a aprovação continua na tela", () => {
    const asked = { ...working, awaiting: true };
    expect(noticesBetween({ a: working }, { a: asked }, null)).toEqual([{ ref: "a", kind: "approval" }]);
    expect(noticesBetween({ a: asked }, { a: asked }, null)).toEqual([]);
  });

  it("pergunta em aberto avisa uma vez", () => {
    const asking = { ...working, question: true };
    expect(noticesBetween({ a: working }, { a: asking }, null)).toEqual([{ ref: "a", kind: "question" }]);
    expect(noticesBetween({ a: asking }, { a: asking }, null)).toEqual([]);
  });

  it("falha avisa como falha, e o fim desse turno não vira também 'terminou'", () => {
    const failedWhileWorking = { ...working, failed: true };
    expect(noticesBetween({ a: working }, { a: failedWhileWorking }, null)).toEqual([{ ref: "a", kind: "failed" }]);
    // O turno acaba depois, com a falha ainda marcada: nenhum aviso novo.
    expect(noticesBetween({ a: failedWhileWorking }, { a: { ...idle, failed: true } }, null)).toEqual([]);
    // Falha que chega junto com o fim do turno: sai só "falhou".
    expect(noticesBetween({ a: working }, { a: { ...idle, failed: true } }, null)).toEqual([{ ref: "a", kind: "failed" }]);
  });

  it("com mais de um motivo no mesmo passo, sai um aviso só: o mais urgente", () => {
    const burst = { phase: "idle" as const, awaiting: true, question: true, failed: true };
    expect(noticesBetween({ a: working }, { a: burst }, null)).toEqual([{ ref: "a", kind: "approval" }]);
    expect(noticesBetween({ a: { ...working, question: false } }, { a: { ...idle, question: true, failed: true } }, null))
      .toEqual([{ ref: "a", kind: "question" }]);
  });

  it("fase desconhecida (unknown) não conta como fim de turno, nem para trás nem para frente", () => {
    const unknown = { ...idle, phase: "unknown" as const };
    expect(noticesBetween({ a: working }, { a: unknown }, null)).toEqual([]);
    expect(noticesBetween({ a: unknown }, { a: idle }, null)).toEqual([]);
  });

  it("várias conversas no mesmo passo saem na ordem em que aparecem", () => {
    const out = noticesBetween(
      { a: working, b: idle, c: working },
      { a: idle, b: { ...idle, awaiting: true }, c: { ...idle, failed: true } },
      null,
    );
    expect(out).toEqual([
      { ref: "a", kind: "done" },
      { ref: "b", kind: "approval" },
      { ref: "c", kind: "failed" },
    ]);
  });
});

describe("avisos no app: o estado de cada conversa", () => {
  it("aba (TUI): fase, pergunta e aprovação vêm do canal", () => {
    const out = noticeStatesOf(["tab-1", "tab-2"],
      { phase: { "tab-1": "working" }, question: { "tab-1": true }, awaiting: { "tab-2": "Bash" } },
      {},
    );
    expect(out["tab-1"]).toEqual({ phase: "working", awaiting: false, question: true, failed: false });
    expect(out["tab-2"]).toEqual({ phase: "unknown", awaiting: true, question: false, failed: false });
  });

  it("protocolo: pedido de aprovação pendente conta; pergunta é outra coisa; respondido não conta", () => {
    const threads = {
      t1: hilo({ phase: "working", requests: [request("command", "pending")] }),
      t2: hilo({ requests: [request("question", "pending")] }),
      t3: hilo({ requests: [request("command", "answered"), request("question", "answered")] }),
    };
    const out = noticeStatesOf(["thread:t1", "thread:t2", "thread:t3"],
      { phase: {}, question: {}, awaiting: {} },
      threads,
    );
    expect(out["thread:t1"]).toEqual({ phase: "working", awaiting: true, question: false, failed: false });
    expect(out["thread:t2"]).toEqual({ phase: "idle", awaiting: false, question: true, failed: false });
    expect(out["thread:t3"]).toEqual({ phase: "idle", awaiting: false, question: false, failed: false });
  });

  it("protocolo com erro no hilo marca falha", () => {
    const out = noticeStatesOf(["thread:t1"], { phase: {}, question: {}, awaiting: {} }, { t1: hilo({ error: "boom" }) });
    expect(out["thread:t1"]?.failed).toBe(true);
  });

  it("conversa de protocolo sem estado ao vivo fica de fora (não há o que comparar)", () => {
    expect(noticeStatesOf(["thread:nada"], { phase: {}, question: {}, awaiting: {} }, {})).toEqual({});
  });
});
