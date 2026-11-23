// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { startUsagePolling, useUsageStore } from "../usageStore";

const NOW = 1_700_000_000;
const account = (over: Partial<AgentAccount> = {}) =>
  ({ id: "c1", agentId: "claude-code", name: "c", kind: "login", loggedIn: true, ...over }) as unknown as AgentAccount;
const good = (over = {}) => ({
  available: true, session: { percent: 10, resets: "3pm" }, week: { percent: 20, resets: "Mon 9am" }, weekModels: [], fetchedAt: NOW, cached: false, problem: null, ...over,
});
const failed = (problem: string, over = {}) => ({
  available: false, session: null, week: null, weekModels: [], fetchedAt: NOW, cached: false, problem, ...over,
});

describe("usageStore · claude", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    claude.mockReset();
    useUsageStore.setState({ claude: {}, busy: {}, plan: {} });
  });

  afterEach(() => {
    startUsagePolling([], false);
    vi.useRealTimers();
  });

  it("uma falha por rejeição conserva a última leitura boa", async () => {
    claude.mockResolvedValueOnce(good());
    await useUsageStore.getState().refresh(account(), true);
    claude.mockRejectedValueOnce(new Error("timeout"));
    await useUsageStore.getState().refresh(account(), true);
    const entry = useUsageStore.getState().claude.c1;
    expect(entry.available).toBe(true);
    expect(entry.session).toEqual(good().session);
    expect(entry.week).toEqual(good().week);
    expect(entry.problem).toContain("timeout");
  });

  it("uma resposta com available:false após cache vencido NÃO apaga a última leitura boa", async () => {
    const stale = good({ fetchedAt: NOW - 600, cached: true });
    claude.mockResolvedValueOnce(stale);
    claude.mockResolvedValueOnce(failed("accounts.plan.problem.rateLimited", { retryAt: NOW + 180 }));

    await useUsageStore.getState().refresh(account(), false);

    expect(claude).toHaveBeenNthCalledWith(1, "c1", false, false);
    expect(claude).toHaveBeenNthCalledWith(2, "c1", true, false);
    const entry = useUsageStore.getState().claude.c1;
    expect(entry.available).toBe(true);
    expect(entry.session).toEqual(stale.session);
    expect(entry.week).toEqual(stale.week);
    expect(entry.fetchedAt).toBe(stale.fetchedAt);
    expect(entry.problem).toBe("accounts.plan.problem.rateLimited");
    expect(entry.retryAt).toBe(NOW + 180);
  });

  it("erro de autenticação limpa o cache antigo para mostrar login expirado", async () => {
    claude.mockResolvedValueOnce(good());
    await useUsageStore.getState().refresh(account(), true);
    claude.mockResolvedValueOnce(failed("accounts.auth.expired"));
    await useUsageStore.getState().refresh(account(), true);

    const entry = useUsageStore.getState().claude.c1;
    expect(entry.available).toBe(false);
    expect(entry.session).toBeNull();
    expect(entry.problem).toBe("accounts.auth.expired");
  });

  it("respeita retryAt em chamadas automáticas e permite refresh manual", async () => {
    useUsageStore.setState({
      claude: { c1: good({ fetchedAt: NOW - 600, cached: true, problem: "accounts.plan.problem.rateLimited", retryAt: NOW + 120 }) },
    });
    claude.mockResolvedValueOnce(good({ fetchedAt: NOW - 600, cached: true, problem: "accounts.plan.problem.rateLimited", retryAt: NOW + 120 }));

    await useUsageStore.getState().refresh(account(), false);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(claude).toHaveBeenCalledWith("c1", false, false);

    claude.mockResolvedValueOnce(good({ fetchedAt: NOW, cached: false, problem: null }));
    await useUsageStore.getState().refresh(account(), true);
    expect(claude).toHaveBeenNthCalledWith(2, "c1", true, true);
    expect(useUsageStore.getState().claude.c1.problem).toBeNull();
  });

  it("conta por API key do Claude não dispara leitura de cota", async () => {
    await useUsageStore.getState().refresh(account({ id: "api-1", kind: "api_key" }), false);
    expect(claude).not.toHaveBeenCalled();
  });

  it("polling do canvas tem cooldown na visibilidade e intervalo longo (sem polling agressivo)", async () => {
    claude.mockResolvedValue(good());
    const acc = account();
    const stop = startUsagePolling([acc], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledTimes(1);

    // Alternar visibilidade dentro do cooldown não dispara nova varredura.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledTimes(1);

    // 5 minutos depois também ainda não dispara (intervalo mínimo maior que 5 min).
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(claude).toHaveBeenCalledTimes(1);

    stop();
  });
});
