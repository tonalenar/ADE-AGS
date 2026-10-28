import { beforeEach, describe, expect, it, vi } from "vitest";

const discover = vi.fn();
const agy = vi.fn();
vi.mock("@/features/accounts/ipc", () => ({
  accountEnv: vi.fn(),
  codexAccountUsage: vi.fn(),
  discoverAntigravityAccount: (id: string) => discover(id),
  antigravityCliUsage: (force: boolean) => agy(force),
}));

import type { AgentAccount } from "@/features/accounts/types";

import { refreshAllUsage, useUsageStore } from "../usageStore";

const account = { id: "a1", agentId: "antigravity", name: "ag" } as unknown as AgentAccount;

describe("usageStore · antigravity", () => {
  beforeEach(() => {
    discover.mockReset();
    useUsageStore.setState({ antigravity: {}, busy: {} });
  });

  it("guarda las barras por modelo, las más gastadas primero", async () => {
    discover.mockResolvedValue({
      accountId: "a1", projectId: "p", inferenceVerified: false,
      models: [{ id: "x", name: "X", remainingFraction: 0.9 }, { id: "y", name: "Y", remainingFraction: 0.2 }],
    });
    await useUsageStore.getState().refresh(account, true);
    const entry = useUsageStore.getState().antigravity.a1;
    expect(entry.failed).toBe(false);
    expect(entry.meters?.map((m) => m.id)).toEqual(["y", "x"]);
    expect(entry.fetchedAt).toBeGreaterThan(0);
    expect(useUsageStore.getState().busy.a1).toBe(false);
  });

  it("si falla, marca el error y conserva el último valor bueno", async () => {
    discover.mockResolvedValueOnce({ accountId: "a1", projectId: "p", inferenceVerified: false, models: [{ id: "x", name: "X", remainingFraction: 0.5 }] });
    await useUsageStore.getState().refresh(account, true);
    discover.mockRejectedValueOnce(new Error("red"));
    await useUsageStore.getState().refresh(account, true);
    const entry = useUsageStore.getState().antigravity.a1;
    expect(entry.failed).toBe(true);
    expect(entry.meters).toHaveLength(1);
  });
});

describe("usageStore · agy /usage", () => {
  const groups = [{ name: "Gemini Models", windows: [
    { id: "gemini-weekly", kind: "weekly", usedPct: 7.8, resetsAt: "2026-10-31T12:35:00Z" },
    { id: "gemini-5h", kind: "session", usedPct: 0 },
  ] }];
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    agy.mockReset();
    useUsageStore.setState({ agy: { usage: null, failed: false }, busy: {} });
  });

  it("lo fresco del SQLite se queda y no corre el CLI", async () => {
    agy.mockResolvedValue({ installed: true, groups, fetchedAt: now(), cached: true });
    await useUsageStore.getState().refreshAgy(false);
    expect(agy).toHaveBeenCalledTimes(1);
    expect(agy).toHaveBeenCalledWith(false);
    expect(useUsageStore.getState().agy.usage?.groups[0].windows).toHaveLength(2);
  });

  it("lo vencido se muestra y se vuelve a preguntar en vivo", async () => {
    agy.mockResolvedValueOnce({ installed: true, groups, fetchedAt: 1, cached: true });
    agy.mockResolvedValueOnce({ installed: true, groups: [], fetchedAt: now(), cached: false });
    await useUsageStore.getState().refreshAgy(false);
    expect(agy.mock.calls).toEqual([[false], [true]]);
    expect(useUsageStore.getState().agy.usage?.groups).toEqual([]);
  });

  it("sin agy no vuelve a preguntar; si falla, conserva lo último", async () => {
    agy.mockResolvedValueOnce({ installed: false, groups: [], fetchedAt: 0, cached: false });
    await useUsageStore.getState().refreshAgy(false);
    expect(agy).toHaveBeenCalledTimes(1);
    agy.mockResolvedValueOnce({ installed: true, groups, fetchedAt: now(), cached: false });
    await useUsageStore.getState().refreshAgy(true);
    agy.mockRejectedValueOnce(new Error("timeout"));
    await useUsageStore.getState().refreshAgy(true);
    const entry = useUsageStore.getState().agy;
    expect(entry.failed).toBe(true);
    expect(entry.usage?.groups).toHaveLength(1);
    expect(useUsageStore.getState().busy["agy:local"]).toBe(false);
  });
});

describe("refreshAllUsage", () => {
  it("fuerza agy y las cuentas, todo en vivo", async () => {
    agy.mockReset();
    discover.mockReset();
    agy.mockResolvedValue({ installed: true, groups: [], fetchedAt: Math.floor(Date.now() / 1000), cached: false });
    discover.mockResolvedValue({ accountId: "a1", projectId: "p", inferenceVerified: false, models: [] });
    await refreshAllUsage([account]);
    expect(agy).toHaveBeenCalledWith(true);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(Object.values(useUsageStore.getState().busy).some(Boolean)).toBe(false);
  });
});
