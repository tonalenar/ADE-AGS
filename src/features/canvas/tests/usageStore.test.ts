import { beforeEach, describe, expect, it, vi } from "vitest";

const discover = vi.fn();
vi.mock("@/features/accounts/ipc", () => ({
  accountEnv: vi.fn(),
  codexAccountUsage: vi.fn(),
  discoverAntigravityAccount: (id: string) => discover(id),
}));

import type { AgentAccount } from "@/features/accounts/types";

import { useUsageStore } from "../usageStore";

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
