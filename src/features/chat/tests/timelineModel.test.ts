import { describe, expect, it } from "vitest";

import { changedFiles, endOutcome, fileName, formatDuration, noticeDetail, openTurnStart, timelineTurns } from "@/features/chat/timeline/timelineModel";
import type { TimelineItem } from "@/features/chat/timeline/types";

const user = (id: string, at?: number): TimelineItem => ({ kind: "user", id, at, text: `msg ${id}` });
const say = (id: string): TimelineItem => ({ kind: "assistant", id, text: "ok" });
const tool = (id: string, patch: Partial<TimelineItem> = {}): TimelineItem => ({ kind: "tool", id, tool: "read", status: "done", ...patch });
const end = (id: string, patch: Partial<TimelineItem> = {}): TimelineItem => ({ kind: "turnEnd", id, ...patch });

describe("timelineTurns", () => {
  it("põe o trabalho no fold e deixa a última fala e os arquivos de fora", () => {
    const [turn] = timelineTurns([
      user("u1", 1000),
      say("a1"),
      tool("t1"),
      tool("t2", { tool: "edit", path: "src/a.ts", added: 3, removed: 1 }),
      say("a2"),
      tool("t3", { tool: "edit", path: "src/a.ts", added: 2, removed: 0 }),
      tool("t4", { tool: "write", path: "src/b.ts", added: 10, removed: 0, status: "denied" }),
      say("a3"),
      end("e1", { durationMs: 4200 }),
    ]);
    expect(turn!.user?.id).toBe("u1");
    expect(turn!.body.map((r) => r.type)).toEqual(["assistant", "work", "assistant", "work"]);
    expect(turn!.body[1]!.type === "work" && turn!.body[1]!.tools.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(turn!.final?.id).toBe("a3");
    expect(turn!.end).toEqual({ durationMs: 4200, interrupted: false, error: null, files: [{ path: "src/a.ts", added: 5, removed: 1 }] });
  });

  it("sem duração no arquivo, mede do prompt até o fim; turno sem fim fica aberto", () => {
    const turns = timelineTurns([user("u1", 1000), end("e1", { at: 6000, interrupted: true }), user("u2", 7000), tool("t1", { status: "running" })]);
    expect(turns[0]!.end).toMatchObject({ durationMs: 5000, interrupted: true });
    expect(turns[1]!.end).toBeNull();
    expect(turns[1]!.body).toHaveLength(1);
  });

  it("o texto do fim de turno é o erro: fica no turno, e um turno com erro não é 'concluído'", () => {
    const turns = timelineTurns([
      user("u1", 1000), say("a1"), end("e1", { at: 2000, text: "  API fora do ar  " }),
      user("u2", 3000), end("e2", { at: 4000, interrupted: true }),
      user("u3", 5000), end("e3", { at: 6000, interrupted: false, text: "   " }),
    ]);
    expect(turns[0]!.end).toMatchObject({ error: "API fora do ar", interrupted: false });
    expect(turns[1]!.end).toMatchObject({ error: null, interrupted: true });
    expect(turns[2]!.end).toMatchObject({ error: null, interrupted: false });
    expect(endOutcome(turns[0]!.end!)).toBe("error");
    expect(endOutcome(turns[1]!.end!)).toBe("interrupted");
    expect(endOutcome(turns[2]!.end!)).toBe("done");
    // Falhou e foi marcado como interrompido: o erro vence, porque a pessoa não parou nada.
    const both = timelineTurns([user("u1"), end("e1", { interrupted: true, text: "O processo caiu" })]);
    expect(endOutcome(both[0]!.end!)).toBe("error");
  });

  it("pergunta em aberto vira um cartão; respondida some", () => {
    expect(timelineTurns([user("u1"), tool("q1", { tool: "question", status: "running", question: { text: "Qual?", options: ["A"] } })])[0]!.body.map((r) => r.type)).toEqual(["question"]);
    expect(timelineTurns([user("u1"), tool("q1", { tool: "question", status: "done" })])[0]!.body).toEqual([]);
  });

  it("arquivo começando no meio de um turno abre um turno sem mensagem", () => {
    const [turn] = timelineTurns([say("a1"), end("e1")]);
    expect(turn!.user).toBeNull();
    expect(turn!.final?.id).toBe("a1");
  });
});

describe("openTurnStart", () => {
  it("o turno em aberto começa na última mensagem sem fim depois", () => {
    expect(openTurnStart([user("u1", 10), end("e1"), user("u2", 50), say("a")])).toBe(50);
    expect(openTurnStart([user("u1", 10), end("e1")])).toBeNull();
  });
});

describe("utilitários", () => {
  it("formatDuration", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });

  it("fileName e changedFiles ignoram erro", () => {
    expect(fileName("/a/b/c.ts")).toBe("c.ts");
    expect(changedFiles([tool("x", { tool: "edit", path: "p", added: 1, removed: 1, status: "error" })])).toEqual([]);
  });
});

describe("timelineTurns: mensagem no meio do turno (steer, fila)", () => {
  it("fecha o turno anterior ao chegar uma nova mensagem, e o fim vai para o turno da mensagem nova", () => {
    const turns = timelineTurns([
      user("u1", 1000), tool("t1"), say("a1"),
      user("u2", 2000), tool("t2"), say("a2"),
      end("e1", { at: 5000, durationMs: 4000 }),
    ]);
    expect(turns).toHaveLength(2);
    // O primeiro não fica "em aberto" para sempre: fecha ao ser superado, com o que já tinha.
    expect(turns[0]!.end).toEqual({ durationMs: null, interrupted: false, error: null, files: [], superseded: true });
    expect(turns[0]!.final?.id).toBe("a1");
    // O fim de verdade é do turno que tem a resposta.
    expect(turns[1]!.end).toMatchObject({ durationMs: 4000, interrupted: false });
    expect(turns[1]!.end?.superseded).toBeUndefined();
    expect(turns[1]!.final?.id).toBe("a2");
  });

  it("o arquivo editado no turno superado continua contado nele", () => {
    const [first] = timelineTurns([user("u1"), tool("t1", { tool: "edit", path: "src/a.ts", added: 2, removed: 1 }), user("u2")]);
    expect(first!.end?.files).toEqual([{ path: "src/a.ts", added: 2, removed: 1 }]);
  });

  it("uma injeção do ADE (sem bolha) no meio do turno não abre outro turno", () => {
    const injection: TimelineItem = { kind: "user", id: "inj", text: "[ADE AGS] Você entrou no time." };
    const turns = timelineTurns([user("u1", 1000), tool("t1"), injection, say("a1"), end("e1")]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.end).not.toBeNull();
    expect(turns[0]!.end?.superseded).toBeUndefined();
  });

  it("o aviso do app é uma linha própria e não abre nem fecha o turno em andamento", () => {
    const notice: TimelineItem = { kind: "notice", id: "n1", label: "resumeLost", text: "A sessão anterior não pôde ser retomada" };
    const turns = timelineTurns([user("u1", 1000), notice, say("a1"), end("e1")]);
    expect(turns.map((t) => t.notice?.id ?? t.user?.id)).toEqual(["u1", "n1"]);
    expect(turns[0]!.body.map((r) => r.type)).toEqual([]);
    expect(turns[0]!.final?.id).toBe("a1");
    expect(turns[0]!.end).not.toBeNull();
  });
});

describe("noticeDetail", () => {
  it("mostra o motivo da sessão que não voltou, a mensagem que não foi enviada e a opção ignorada", () => {
    expect(noticeDetail({ kind: "notice", id: "n", label: "resumeLost", text: "A sessão anterior não pôde ser retomada; o agente recomeçou sem o histórico dele. Motivo: thread not found" })).toBe("thread not found");
    expect(noticeDetail({ kind: "notice", id: "n", label: "resumeLost", text: "A sessão anterior não pôde ser retomada; o agente recomeçou sem o histórico dele." })).toBeNull();
    expect(noticeDetail({ kind: "notice", id: "n", label: "queueDropped", text: "e o lint?" })).toBe("e o lint?");
    expect(noticeDetail({ kind: "notice", id: "n", label: "optionIgnored", text: "O esforço \"ultra\" não existe" })).toBe("O esforço \"ultra\" não existe");
    expect(noticeDetail({ kind: "notice", id: "n", label: "algoNovo", text: "texto" })).toBe("texto");
  });
});
