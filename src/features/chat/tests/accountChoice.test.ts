import { describe, expect, it } from "vitest";

import type { RosterAccount, RosterAgent } from "@/features/runs/types";
import { accountState, choosableAccounts, hasChoice } from "../accountChoice";

const acc = (over: Partial<RosterAccount>): RosterAccount => ({
  accountId: "a", key: "k", name: "Ton", label: null, loggedIn: true, quota: null, running: 0, models: [], modelDiscovery: "ok",
  ...over,
}) as RosterAccount;
const agent = (accounts: RosterAccount[]): RosterAgent => ({ agentId: "claude-code", label: "Claude Code", accounts }) as RosterAgent;
const quota = (rejected: boolean, until: number | null) => ({ fiveHour: null, sevenDay: null, rejected, rejectedUntil: until, overage: false, observedAt: 1 });

describe("accountState", () => {
  it("esgotada enquanto a renovação não passou; sem hora, enquanto o aviso valer", () => {
    expect(accountState(acc({ quota: quota(true, 2_000) }), 1_000)).toBe("exhausted");
    expect(accountState(acc({ quota: quota(true, null) }), 1_000)).toBe("exhausted");
    expect(accountState(acc({ quota: quota(true, 900) }), 1_000)).toBe("ready");
  });
  it("sem login vem antes; conectada é o resto", () => {
    expect(accountState(acc({ loggedIn: false, quota: quota(true, 2_000) }), 1_000)).toBe("needsLogin");
    expect(accountState(acc({}), 1_000)).toBe("ready");
  });
});

describe("choosableAccounts", () => {
  it("lista a principal (accountId null) e as outras pelo rótulo ou nome", () => {
    const list = choosableAccounts(agent([acc({ accountId: null, name: "Claude Code" }), acc({ accountId: "b", name: "Erist", label: "eri@x.com" })]), 1_000);
    expect(list.map((a) => [a.value, a.name, a.state])).toEqual([["", "Claude Code", "ready"], ["b", "eri@x.com", "ready"]]);
  });
  it("só há escolha com 2 ou mais contas", () => {
    expect(hasChoice(agent([acc({ accountId: null })]))).toBe(false);
    expect(hasChoice(agent([acc({ accountId: null }), acc({ accountId: "b" })]))).toBe(true);
    expect(hasChoice(undefined)).toBe(false);
  });
  it("não duplica a conta principal quando uma conta extra tem o mesmo e-mail", () => {
    const dup = agent([
      acc({ accountId: null, name: "Claude Code", label: "eristonalencaar@gmail.com" }),
      acc({ accountId: "b", name: "extra", label: "eristonalencaar@gmail.com" }),
    ]);
    const list = choosableAccounts(dup, 1_000);
    expect(list.map((a) => [a.value, a.name])).toEqual([["", "eristonalencaar@gmail.com"]]);
    expect(hasChoice(dup, 1_000)).toBe(false);
  });
  it("mantém contas distintas sem e-mail (ex.: Principal e Kiro0 do Antigravity)", () => {
    const agy = agent([
      acc({ accountId: null, name: "Antigravity", label: null }),
      acc({ accountId: "kiro", name: "Kiro0", label: null }),
    ]);
    const list = choosableAccounts(agy, 1_000);
    expect(list.map((a) => [a.value, a.name])).toEqual([["", "Antigravity"], ["kiro", "Kiro0"]]);
    expect(hasChoice(agy, 1_000)).toBe(true);
  });
  it("se a conversa atual está na conta extra com mesmo e-mail da principal, mantém a ativa sem duplicar", () => {
    const dup = agent([
      acc({ accountId: null, name: "Claude Code", label: "eristonalencaar@gmail.com" }),
      acc({ accountId: "b", name: "extra", label: "eristonalencaar@gmail.com" }),
      acc({ accountId: "c", name: "Kiro0", label: null }),
    ]);
    const list = choosableAccounts(dup, 1_000, { currentAccountId: "b" });
    expect(list.map((a) => [a.value, a.name])).toEqual([["b", "eristonalencaar@gmail.com"], ["c", "Kiro0"]]);
  });
});
