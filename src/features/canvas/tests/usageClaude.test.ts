import { beforeEach, describe, expect, it, vi } from "vitest";

const claude = vi.fn();
vi.mock("@/features/accounts/ipc", () => ({
  codexAccountUsage: vi.fn(),
  discoverAntigravityAccount: vi.fn(),
  antigravityCliUsage: vi.fn(),
}));
vi.mock("@/features/accounts/usage", async () => {
  const actual = await vi.importActual<typeof import("@/features/accounts/usage")>("@/features/accounts/usage");
  return { ...actual, claudeLiveUsage: (...args: unknown[]) => claude(...args), agentAccountUsage: vi.fn() };
});

import type { AgentAccount } from "@/features/accounts/types";
import { useUsageStore } from "../usageStore";

const account = { id: "c1", agentId: "claude-code", name: "c" } as unknown as AgentAccount;
const good = {
  available: true, session: { usedPct: 10 }, week: { usedPct: 20 }, weekModels: [], fetchedAt: 100, cached: false, problem: null,
};

describe("usageStore · claude", () => {
  beforeEach(() => {
    claude.mockReset();
    useUsageStore.setState({ claude: {}, busy: {} });
  });

  it("uma falha conserva a última leitura boa", async () => {
    claude.mockResolvedValueOnce(good);
    await useUsageStore.getState().refresh(account, true);
    claude.mockRejectedValueOnce(new Error("timeout"));
    await useUsageStore.getState().refresh(account, true);
    const entry = useUsageStore.getState().claude.c1;
    expect(entry.available).toBe(true);
    expect(entry.session).toEqual(good.session);
    expect(entry.week).toEqual(good.week);
    expect(entry.problem).toContain("timeout");
  });
});
