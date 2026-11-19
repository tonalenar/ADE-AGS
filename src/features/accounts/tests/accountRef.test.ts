import { describe, expect, it } from "vitest";

import {
  accountRefFromWire, accountRefToWire, principalRef, sameAccountRef, selectedAccountId,
} from "@/features/accounts/accountRef";

describe("AccountRef", () => {
  it("sem valor, vazio ou só espaços é a conta principal do agente", () => {
    for (const wire of [null, undefined, "", "   "]) {
      expect(accountRefFromWire("claude-code", wire)).toEqual({ kind: "account", agentId: "claude-code", accountId: null });
    }
    expect(principalRef("codex")).toEqual({ kind: "account", agentId: "codex", accountId: null });
  });

  it("um id é uma conta; pool:<nome> é um pool, separado do id", () => {
    expect(accountRefFromWire("claude-code", "f6af9857")).toEqual({ kind: "account", agentId: "claude-code", accountId: "f6af9857" });
    expect(accountRefFromWire("claude-code", "pool:time")).toEqual({ kind: "pool", agentId: "claude-code", pool: "time" });
    // O prefixo vale em qualquer caixa, como em `isPoolValue`, e o nome vem aparado.
    expect(accountRefFromWire("claude-code", "POOL: time ")).toEqual({ kind: "pool", agentId: "claude-code", pool: "time" });
  });

  it("um pool sem nome não é um pool: cai na conta principal", () => {
    expect(accountRefFromWire("claude-code", "pool:")).toEqual(principalRef("claude-code"));
    expect(accountRefFromWire("claude-code", "pool:   ")).toEqual(principalRef("claude-code"));
  });

  it("serializa de volta ao valor que o backend e as preferências já usam", () => {
    expect(accountRefToWire(principalRef("claude-code"))).toBeNull();
    expect(accountRefToWire(null)).toBeNull();
    expect(accountRefToWire(accountRefFromWire("claude-code", "abc"))).toBe("abc");
    expect(accountRefToWire(accountRefFromWire("claude-code", "pool:time"))).toBe("pool:time");
  });

  it("ida e volta preserva o valor", () => {
    for (const wire of [null, "abc", "pool:time", "pool:com espaço"]) {
      expect(accountRefToWire(accountRefFromWire("codex", wire))).toBe(wire);
    }
  });

  it("selectedAccountId só devolve id de conta de verdade, nunca o de um pool", () => {
    expect(selectedAccountId(accountRefFromWire("codex", "abc"))).toBe("abc");
    expect(selectedAccountId(accountRefFromWire("codex", "pool:x"))).toBeNull();
    expect(selectedAccountId(principalRef("codex"))).toBeNull();
    expect(selectedAccountId(null)).toBeNull();
  });

  it("compara agente, tipo e conta; ausente vale como principal", () => {
    const a = accountRefFromWire("codex", "abc");
    expect(sameAccountRef(a, accountRefFromWire("codex", "abc"))).toBe(true);
    expect(sameAccountRef(a, accountRefFromWire("codex", "xyz"))).toBe(false);
    expect(sameAccountRef(a, accountRefFromWire("claude-code", "abc"))).toBe(false);
    expect(sameAccountRef(accountRefFromWire("codex", "pool:abc"), a)).toBe(false);
    expect(sameAccountRef(null, principalRef("codex"), "codex")).toBe(true);
    expect(sameAccountRef(null, a, "codex")).toBe(false);
  });
});
