import { describe, expect, it } from "vitest";

import type { ThreadRow } from "../../structured/ipc";
import { buildLineage, formatElapsed, parseMaxAgents, parseQueue, waitingSummary, type LineageEntry, type MemberStateRow } from "../lineageModel";

const thread = (id: string, over: Partial<ThreadRow> = {}): ThreadRow => ({
  id, agentId: "codex", cwd: "/r", title: id, model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1000, updatedAt: 2000, ...over,
});
const row = (member: string, state: MemberStateRow["state"], since = 5000): MemberStateRow => ({ member: `thread:${member}`, parent: "thread:pai", state, since });
const idle = () => undefined;

describe("linhagem do pai", () => {
  it("separa quem roda de quem já acabou e conta os que falharam", () => {
    const threads = [thread("pai"), thread("a", { parentRef: "thread:pai" }), thread("b", { parentRef: "thread:pai", createdAt: 500 }), thread("c", { parentRef: "thread:pai" }), thread("d", { parentRef: "thread:pai" })];
    const states = [row("a", "working"), row("b", "waiting_input"), row("c", "failed"), row("d", "idle")];
    const lineage = buildLineage("pai", threads, states, idle);
    expect(lineage.running.map((e) => e.threadId)).toEqual(["b", "a"]);
    expect(lineage.previous.map((e) => e.threadId).sort()).toEqual(["c", "d"]);
    expect(lineage.failed).toBe(1);
  });
  it("integrante do time entra pelo estado, mesmo sem parent_ref", () => {
    const lineage = buildLineage("pai", [thread("pai"), thread("m")], [row("m", "ended_without_delivery")], idle);
    expect(lineage.previous.map((e) => [e.threadId, e.state])).toEqual([["m", "ended_without_delivery"]]);
  });
  it("a fase ao vivo vence o estado atrasado e filho concluído nunca fica em execução", () => {
    const threads = [thread("pai"), thread("a", { parentRef: "thread:pai" }), thread("z", { parentRef: "thread:pai", state: "settled" })];
    const lineage = buildLineage("pai", threads, [row("a", "idle"), row("z", "working")], (id) => (id === "a" ? "working" : undefined));
    expect(lineage.running.map((e) => e.threadId)).toEqual(["a"]);
    expect(lineage.previous.map((e) => e.threadId)).toEqual(["z"]);
  });
  it("filho de outro pai não aparece", () => {
    expect(buildLineage("pai", [thread("pai"), thread("x", { parentRef: "thread:outro" })], [], idle).running).toEqual([]);
  });
});

describe("tempo decorrido", () => {
  it("formata como o T3 Code", () => {
    expect(formatElapsed(9_350_000)).toBe("2h 35m 50s");
    expect(formatElapsed(245_000)).toBe("4m 05s");
    expect(formatElapsed(12_900)).toBe("12s");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("aguardando N subagentes e a fila do time", () => {
  const entry = (id: string): LineageEntry => ({ threadId: id, title: `Tarefa ${id}`, agentId: "codex", state: "working", since: 1, startedAt: 1, settled: false });
  it("resume os nomes de quem roda", () => {
    expect(waitingSummary([entry("a"), entry("b")])).toEqual({ count: 2, names: "Tarefa a · Tarefa b" });
    expect(waitingSummary([])).toEqual({ count: 0, names: "" });
  });
  it("lê a fila só com o que está esperando e tolera resposta estranha", () => {
    const raw = { maxAgents: 3, items: [
      { id: "q1", status: "pending", title: "Timeline", waitingOn: ["esperando Ana terminar", 5], areas: ["src/a"], createdAt: 9 },
      { id: "q2", status: "launched", title: "Já foi" },
      { id: "q3", status: "pending", waitingOn: [] },
      { status: "pending" },
    ] };
    const { rows, maxAgents } = parseQueue(raw);
    expect(maxAgents).toBe(3);
    expect(rows.map((r) => [r.id, r.title, r.waitingOn])).toEqual([["q1", "Timeline", ["esperando Ana terminar"]], ["q3", "q3", []]]);
    expect(parseQueue([]).rows).toEqual([]);
    expect(parseQueue(null)).toEqual({ rows: [], maxAgents: null });
  });
  it("o limite de agentes tem padrão 3 e faixa 1 a 12", () => {
    expect([parseMaxAgents(null), parseMaxAgents("x"), parseMaxAgents("5"), parseMaxAgents("0"), parseMaxAgents("99")]).toEqual([3, 3, 5, 1, 12]);
  });
});
