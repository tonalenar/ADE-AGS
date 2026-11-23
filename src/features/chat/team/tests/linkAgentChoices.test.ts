import { describe, expect, it } from "vitest";

import type { Roster, RosterAccount } from "@/features/runs/types";
import type { AgentInfo } from "@/features/tabs/types";

import { agentChoices } from "../linkAgentChoices";

const account = (accountId: string | null, name: string, over: Partial<RosterAccount> = {}): RosterAccount => ({
  accountId, key: accountId ?? "system", name, label: null, loggedIn: true, quota: null, running: 0, models: [], modelDiscovery: "available", ...over,
});
const roster = (agents: Record<string, RosterAccount[]>): Roster => ({
  agents: Object.entries(agents).map(([agentId, accounts]) => ({
    agentId, label: agentId, installed: true, launchable: true, unavailable: null, models: [], modelDiscovery: "available",
    capabilities: { headless: true, mcp: true, orchestration: true }, accounts,
  })),
});
const AGENTS = [{ id: "antigravity", label: "Antigravity" }, { id: "codex", label: "Codex" }] as AgentInfo[];

describe("agente + conta no «Ligar ao time»", () => {
  it("lista a principal e as contas secundárias de cada agente, como o seletor de modelo", () => {
    const choices = agentChoices(AGENTS, roster({
      antigravity: [account(null, "Antigravity"), account("a4", "alencaar4"), account("k0", "kiro0", { loggedIn: false })],
      codex: [account(null, "Codex")],
    }), [], "Principal");
    expect(choices.map((c) => [c.agent.id, c.accountId, c.loggedIn])).toEqual([
      ["antigravity", null, true], ["antigravity", "a4", true], ["antigravity", "k0", false], ["codex", null, true],
    ]);
    expect(choices[1]!.name).toContain("alencaar4");
  });
  it("sem roster ainda, um por agente (a conta principal)", () => {
    expect(agentChoices(AGENTS, null, [], "Principal").map((c) => [c.agent.id, c.accountId])).toEqual([["antigravity", null], ["codex", null]]);
  });
});
