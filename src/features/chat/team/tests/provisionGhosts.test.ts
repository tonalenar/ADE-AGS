import { describe, expect, it } from "vitest";

import type { TeamProvision } from "../ipc";
import { dismissProvision, ENTERING_VISIBLE_MS, FAILED_VISIBLE_MS, loadDismissedProvisions, visibleProvisions } from "../provisionGhosts";

const prov = (id: string, state: TeamProvision["state"], updatedAt: number): TeamProvision => ({
  id, teamId: "t", label: id, agentId: "codex", role: "qa", member: null, worktree: null, branch: null, state, failure: null, createdAt: updatedAt, updatedAt,
});
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe("fantasmas da sidebar (integrante que nunca entrou)", () => {
  const now = 10_000_000;
  it("o que falhou há muito tempo some sozinho; o recente continua para a pessoa ler o motivo", () => {
    const list = [prov("novo", "failed", now - 1000), prov("velho", "failed", now - FAILED_VISIBLE_MS - 1)];
    expect(visibleProvisions(list, now, new Set()).map((p) => p.id)).toEqual(["novo"]);
  });
  it("'entrando no time…' que passou do prazo é órfão e some", () => {
    const list = [prov("a", "provisioning", now - 1000), prov("b", "provisioning", now - ENTERING_VISIBLE_MS - 1)];
    expect(visibleProvisions(list, now, new Set()).map((p) => p.id)).toEqual(["a"]);
  });
  it("o que a pessoa dispensou não volta, e o ativo nunca aparece aqui", () => {
    const list = [prov("a", "failed", now), prov("b", "active", now)];
    expect(visibleProvisions(list, now, new Set(["a"]))).toEqual([]);
  });
  it("a dispensa é lembrada e não apaga nada", () => {
    const store = memory();
    dismissProvision("a", store);
    dismissProvision("b", store);
    expect([...loadDismissedProvisions(store)]).toEqual(["a", "b"]);
  });
  it("armazenamento corrompido não quebra", () => {
    expect(loadDismissedProvisions({ getItem: () => "{ruim" }).size).toBe(0);
  });
});
