import { beforeEach, describe, expect, it, vi } from "vitest";

import { LAST_AGENT_KEY, loadLastAgent, orderAgents, rememberLastAgent } from "../wizard/lastAgent";
import { SHELL_AGENT_ID } from "../types";

describe("último agente usado", () => {
  let data: Map<string, string>;

  beforeEach(() => {
    data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    });
  });

  it("lembra e lê o último agente", () => {
    expect(loadLastAgent()).toBeNull();
    rememberLastAgent("codex");
    expect(data.get(LAST_AGENT_KEY)).toBe("codex");
    expect(loadLastAgent()).toBe("codex");
    rememberLastAgent("claude");
    expect(loadLastAgent()).toBe("claude");
  });

  it("ignora a terminal pelada e id vazio", () => {
    rememberLastAgent(SHELL_AGENT_ID);
    rememberLastAgent("");
    expect(loadLastAgent()).toBeNull();
    rememberLastAgent("gemini");
    rememberLastAgent(SHELL_AGENT_ID);
    expect(loadLastAgent()).toBe("gemini");
  });

  it("localStorage que lança não quebra", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });
    expect(() => rememberLastAgent("codex")).not.toThrow();
    expect(loadLastAgent()).toBeNull();
  });

  it("orderAgents leva o último para a frente e mantém o resto na ordem", () => {
    const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderAgents(agents, "c").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(orderAgents(agents, "b").map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("orderAgents com id ausente ou nulo mantém a lista", () => {
    const agents = [{ id: "a" }, { id: "b" }];
    expect(orderAgents(agents, "zzz").map((x) => x.id)).toEqual(["a", "b"]);
    expect(orderAgents(agents, null).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("orderAgents não muta a entrada", () => {
    const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const before = [...agents];
    const out = orderAgents(agents, "c");
    expect(agents).toEqual(before);
    expect(out).not.toBe(agents);
  });
});
