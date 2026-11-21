import { describe, expect, it } from "vitest";

import { accountRefFromWire, principalRef } from "@/features/accounts/accountRef";
import { buildRail, parseRailKey, railKeyOf } from "@/features/chat/pickerRail";
import type { AgentAccount } from "@/features/accounts/types";
import type { Roster, RosterAccount } from "@/features/runs/types";

const rosterAccount = (accountId: string | null, name: string, over: Partial<RosterAccount> = {}): RosterAccount => ({
  accountId, key: accountId ?? "system", name, label: null, loggedIn: true, quota: null, running: 0, models: [],
  modelDiscovery: "available", ...over,
});
const roster = (agents: Record<string, RosterAccount[]>): Roster => ({
  agents: Object.entries(agents).map(([agentId, accounts]) => ({
    agentId, label: agentId, installed: true, launchable: true, unavailable: null, models: [], modelDiscovery: "available",
    capabilities: { headless: true, mcp: true, orchestration: true }, accounts,
  })),
});
const identity = (id: string, agentId: string, name: string, over: Partial<AgentAccount> = {}): AgentAccount => ({
  id, agentId, name, dir: "/d", envVar: "X", loginCommand: "x", loggedIn: true, label: null, createdAt: 0, kind: "login",
  baseUrl: null, keyHint: null, displayName: null, accentColor: null, ...over,
});
const AGENTS = [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }];

describe("chave do trilho", () => {
  it("sem conta a chave é o id do agente; com conta ou pool, agente e escolha", () => {
    expect(railKeyOf(principalRef("claude-code"))).toBe("claude-code");
    expect(railKeyOf(accountRefFromWire("claude-code", "abc"))).toBe("claude-code::abc");
    expect(railKeyOf(accountRefFromWire("claude-code", "pool:time"))).toBe("claude-code::pool:time");
  });
  it("lê de volta o que escreveu, como AccountRef", () => {
    expect(parseRailKey("fav")).toEqual({ tab: "fav", ref: null });
    expect(parseRailKey("codex")).toEqual({ tab: "codex", ref: principalRef("codex") });
    expect(parseRailKey("claude-code::abc")).toEqual({ tab: "claude-code", ref: accountRefFromWire("claude-code", "abc") });
    expect(parseRailKey("claude-code::pool:time")).toEqual({ tab: "claude-code", ref: { kind: "pool", agentId: "claude-code", pool: "time" } });
  });
});

describe("buildRail", () => {
  it("um agente com uma conta só e sem cor fica com um ícone e sem selo", () => {
    const items = buildRail(AGENTS, roster({ "claude-code": [rosterAccount(null, "Claude Code")], codex: [rosterAccount(null, "Codex")] }), [], "Principal");
    expect(items.map((i) => [i.key, i.showBadge, i.name])).toEqual([
      ["claude-code", false, "Claude Code"],
      ["codex", false, "Codex"],
    ]);
  });

  it("com duas contas do mesmo agente há um ícone por conta, todos com selo", () => {
    const items = buildRail(
      AGENTS,
      roster({ "claude-code": [rosterAccount(null, "Claude Code"), rosterAccount("a1", "trabalho")], codex: [rosterAccount(null, "Codex")] }),
      [identity("a1", "claude-code", "trabalho", { displayName: "Trabalho", accentColor: "orange" })],
      "Principal",
    );
    expect(items.map((i) => i.key)).toEqual(["claude-code", "claude-code::a1", "codex"]);
    const [principal, trabalho, codex] = items;
    expect(principal).toMatchObject({ accountId: null, badgeLabel: "Principal", showBadge: true, name: "Claude Code · Principal" });
    expect(trabalho).toMatchObject({ accountId: "a1", badgeLabel: "Trabalho", accentColor: "orange", showBadge: true, name: "Claude Code · Trabalho" });
    expect(codex.showBadge).toBe(false);
  });

  it("a conta principal renomeada e colorida usa a identidade guardada em system:<agente>", () => {
    const items = buildRail(
      AGENTS,
      roster({ "claude-code": [rosterAccount(null, "Claude Code"), rosterAccount("a1", "trabalho")] }),
      [identity("system:claude-code", "claude-code", "Claude Code", { displayName: "Pessoal", accentColor: "green" })],
      "Principal",
    );
    expect(items[0]).toMatchObject({ badgeLabel: "Pessoal", accentColor: "green" });
  });

  it("uma conta só mas com cor ganha selo (como no T3)", () => {
    const items = buildRail(
      AGENTS,
      roster({ codex: [rosterAccount(null, "Codex")] }),
      [identity("system:codex", "codex", "Codex", { accentColor: "cyan" })],
      "Principal",
    );
    expect(items.find((i) => i.agentId === "codex")).toMatchObject({ showBadge: true, accentColor: "cyan" });
  });

  it("sem identidade, a conta comum mostra o e-mail no nome e o nome da pasta no selo", () => {
    const items = buildRail(
      AGENTS,
      roster({ "claude-code": [rosterAccount(null, "Claude Code"), rosterAccount("a1", "trabalho", { label: "ton@x.com" })] }),
      [],
      "Principal",
    );
    expect(items[1]).toMatchObject({ badgeLabel: "trabalho", name: "Claude Code · ton@x.com" });
  });

  it("numa conversa aberta (sem trocar de conta) volta a um ícone por agente, sem selo", () => {
    const items = buildRail(
      AGENTS,
      roster({ "claude-code": [rosterAccount(null, "Claude Code"), rosterAccount("a1", "trabalho")] }),
      [identity("a1", "claude-code", "trabalho", { accentColor: "orange" })],
      "Principal",
      false,
    );
    expect(items.map((i) => [i.key, i.showBadge, i.name])).toEqual([
      ["claude-code", false, "Claude Code"],
      ["codex", false, "Codex"],
    ]);
  });

  it("sem roster carregado cada agente tem o seu ícone", () => {
    expect(buildRail(AGENTS, null, [], "Principal").map((i) => i.key)).toEqual(["claude-code", "codex"]);
  });

  it("guarda se a conta está sem login", () => {
    const items = buildRail(
      AGENTS,
      roster({ "claude-code": [rosterAccount(null, "Claude Code"), rosterAccount("a1", "x", { loggedIn: false })] }),
      [],
      "Principal",
    );
    expect(items.filter((i) => i.agentId === "claude-code").map((i) => i.loggedIn)).toEqual([true, false]);
  });

  it("Antigravity com Principal e Kiro0 gera dois itens com selo curto", () => {
    const agyAgents = [{ id: "antigravity", label: "Antigravity" }];
    const items = buildRail(
      agyAgents,
      roster({ antigravity: [rosterAccount(null, "Antigravity"), rosterAccount("kiro", "Kiro0")] }),
      [],
      "Principal",
    );
    expect(items.map((i) => [i.key, i.showBadge, i.badgeLabel, i.name])).toEqual([
      ["antigravity", true, "Principal", "Antigravity · Principal"],
      ["antigravity::kiro", true, "Kiro0", "Antigravity · Kiro0"],
    ]);
  });

  it("não duplica na trilha uma conta extra com o mesmo e-mail da principal", () => {
    const items = buildRail(
      AGENTS,
      roster({
        "claude-code": [
          rosterAccount(null, "Claude Code", { label: "eristonalencaar@gmail.com" }),
          rosterAccount("dup", "clone", { label: "eristonalencaar@gmail.com" }),
        ],
      }),
      [],
      "Principal",
    );
    expect(items.filter((i) => i.agentId === "claude-code").map((i) => i.key)).toEqual(["claude-code"]);
  });
});
