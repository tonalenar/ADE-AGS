import { describe, expect, it } from "vitest";

import type { ThreadRow } from "../../structured/ipc";
import { buildLineage, formatElapsed, type MemberStateRow } from "../lineageModel";

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
