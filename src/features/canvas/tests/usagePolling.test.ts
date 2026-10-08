// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claude = vi.fn();
const codex = vi.fn();
const discover = vi.fn();

vi.mock("@/features/accounts/ipc", () => ({
  accountEnv: vi.fn(async () => ({})),
  codexAccountUsage: (id: string, force?: boolean) => codex(id, force),
  discoverAntigravityAccount: (id: string, force?: boolean) => discover(id, force),
}));

vi.mock("@/features/accounts/usage", async () => {
  const actual = await vi.importActual<typeof import("@/features/accounts/usage")>("@/features/accounts/usage");
  return {
    ...actual,
    claudeLiveUsage: (id: string, env: Record<string, string>, force?: boolean) => claude(id, env, force),
    agentAccountUsage: vi.fn(async () => ({ plan: { tier: null } })),
  };
});

import type { AgentAccount } from "@/features/accounts/types";
import { startUsagePolling, useUsageStore } from "../usageStore";

const claudeAccount = { id: "cl", agentId: "claude-code", name: "c" } as unknown as AgentAccount;
const codexAccount = { id: "cx", agentId: "codex", name: "x" } as unknown as AgentAccount;
const antigravityAccount = { id: "ag", agentId: "antigravity", name: "a" } as unknown as AgentAccount;
const accounts = [claudeAccount, codexAccount, antigravityAccount];

const live = (fetchedAt: number, cached = false) => ({
  available: true, session: null, week: null, weekModels: [], fetchedAt, cached, problem: null,
});

const codexUsage = (fetchedAt: number) => ({
  email: null, plan: null, auth: "chatgpt", quota: null, fetchedAt,
});

function hide(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
}

describe("barrido de cuota", () => {
  let stop = () => {};
  beforeEach(() => {
    stop();
    stop = () => {};
    claude.mockReset();
    codex.mockReset();
    discover.mockReset();
    hide(false);
    useUsageStore.setState({ claude: {}, codex: {}, antigravity: {}, plan: {}, busy: {} });
  });
  afterEach(() => stop());

  it("no llama a invoke con la página oculta", async () => {
    hide(true);
    stop = startUsagePolling(accounts);
    await Promise.resolve();
    expect(claude).not.toHaveBeenCalled();
    expect(codex).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it("no fuerza Codex ni Antigravity si el snapshot sigue fresco", async () => {
    const now = Math.floor(Date.now() / 1000);
    claude.mockResolvedValue(live(now, true));
    codex.mockResolvedValue(codexUsage(now));
    discover.mockResolvedValue({
      accountId: "ag", projectId: "p", inferenceVerified: false, fetchedAt: now, models: [],
    });
    stop = startUsagePolling(accounts);
    await vi.waitFor(() => expect(claude).toHaveBeenCalled());
    expect(codex).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledWith("cx", false);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith("ag", false);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(claude).toHaveBeenCalledWith("cl", {}, false);
  });

  it("pide en vivo cuando el snapshot venció", async () => {
    const now = Math.floor(Date.now() / 1000);
    claude.mockImplementation(async (_id: string, _env: unknown, force?: boolean) => live(force ? now : now - 10_000, !force));
    codex.mockImplementation(async (_id: string, force?: boolean) => codexUsage(force ? now : now - 10_000));
    discover.mockImplementation(async (_id: string, force?: boolean) => ({
      accountId: "ag", projectId: "p", inferenceVerified: false, fetchedAt: force ? now : now - 10_000, models: [],
    }));
    stop = startUsagePolling(accounts);
    await vi.waitFor(() => expect(claude).toHaveBeenCalledTimes(2));
    expect(codex).toHaveBeenNthCalledWith(1, "cx", false);
    expect(codex).toHaveBeenNthCalledWith(2, "cx", true);
    expect(discover).toHaveBeenNthCalledWith(1, "ag", false);
    expect(discover).toHaveBeenNthCalledWith(2, "ag", true);
    expect(claude).toHaveBeenNthCalledWith(1, "cl", {}, false);
    expect(claude).toHaveBeenNthCalledWith(2, "cl", {}, true);
  });
});
