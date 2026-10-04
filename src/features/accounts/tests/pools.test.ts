// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STRATEGIES,
  isPoolValue,
  poolNameOf,
  poolSaveNew,
  poolSetFailover,
  poolValue,
} from "../pools";
import {
  POOL_FAILOVER_TOPIC,
  PoolFailoverNotice,
  type PoolFailoverEvent,
} from "../PoolFailoverNotice";

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mock.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mock.listen(...args),
}));

vi.mock("@/shared/brand/botToastStore", () => ({
  showBotToast: (...args: unknown[]) => mock.toast(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      if (opts) {
        return `${key}:${JSON.stringify(opts)}`;
      }
      return key;
    },
  }),
}));

describe("pools de cuentas (lado de la pantalla)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("un pool se pide como pool:Nombre y se reconoce sin mayúsculas", () => {
    expect(poolValue("Trabajo")).toBe("pool:Trabajo");
    expect(isPoolValue("pool:Trabajo")).toBe(true);
    expect(isPoolValue("POOL:Trabajo")).toBe(true);
    expect(poolNameOf("pool: Dos palabras ")).toBe("Dos palabras");
  });

  it("un id de cuenta o el valor vacío no son un pool", () => {
    expect(isPoolValue("3f2a9c")).toBe(false);
    expect(isPoolValue("auto")).toBe(false);
    expect(isPoolValue(undefined)).toBe(false);
    expect(isPoolValue("")).toBe(false);
  });

  it("las tres estrategias son las del backend", () => {
    expect(STRATEGIES).toEqual(["least_used", "round_robin", "sticky"]);
  });

  it("poolSaveNew inclui o parametro failover na chamada IPC", async () => {
    mock.invoke.mockResolvedValueOnce({
      id: "p1",
      name: "Pool Teste",
      agentId: "claude-code",
      members: [null, "acc-1"],
      strategy: "least_used",
      failover: true,
    });

    await poolSaveNew("Pool Teste", "claude-code", [null, "acc-1"], "least_used", true);

    expect(mock.invoke).toHaveBeenCalledWith("pool_save_new", {
      name: "Pool Teste",
      agentId: "claude-code",
      members: [null, "acc-1"],
      strategy: "least_used",
      failover: true,
    });

    mock.invoke.mockResolvedValueOnce({
      id: "p2",
      name: "Pool Sem Failover",
      agentId: "claude-code",
      members: [null, "acc-2"],
      strategy: "round_robin",
      failover: false,
    });

    await poolSaveNew("Pool Sem Failover", "claude-code", [null, "acc-2"], "round_robin", false);

    expect(mock.invoke).toHaveBeenCalledWith("pool_save_new", {
      name: "Pool Sem Failover",
      agentId: "claude-code",
      members: [null, "acc-2"],
      strategy: "round_robin",
      failover: false,
    });
  });

  it("poolSetFailover envia id e enabled para pool_set_failover sem recriar o pool", async () => {
    mock.invoke.mockResolvedValueOnce({
      id: "p1",
      name: "Pool Teste",
      agentId: "claude-code",
      members: [null, "acc-1"],
      strategy: "sticky",
      failover: true,
    });

    const res = await poolSetFailover("p1", true);
    expect(mock.invoke).toHaveBeenCalledWith("pool_set_failover", {
      id: "p1",
      enabled: true,
    });
    expect(res.failover).toBe(true);

    mock.invoke.mockResolvedValueOnce({
      id: "p1",
      name: "Pool Teste",
      agentId: "claude-code",
      members: [null, "acc-1"],
      strategy: "sticky",
      failover: false,
    });

    const res2 = await poolSetFailover("p1", false);
    expect(mock.invoke).toHaveBeenCalledWith("pool_set_failover", {
      id: "p1",
      enabled: false,
    });
    expect(res2.failover).toBe(false);
  });
});

describe("PoolFailoverNotice (aviso para terminais interativos)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it("registra listener no bus ade-event e limpa ao desmontar", async () => {
    let unlistenCalled = false;
    const unlisten = vi.fn(() => {
      unlistenCalled = true;
    });
    mock.listen.mockResolvedValue(unlisten);

    await act(async () => {
      root?.render(createElement(PoolFailoverNotice));
    });

    expect(mock.listen).toHaveBeenCalledWith("ade-event", expect.any(Function));

    await act(async () => {
      root?.unmount();
    });
    root = null;

    expect(unlistenCalled).toBe(true);
  });

  it("exibe AlertaToast informativo quando chega account.pool_failover", async () => {
    let busHandler: ((e: { payload: { topic: string; data: unknown } }) => void) | null = null;
    mock.listen.mockImplementation((event: string, handler: (e: any) => void) => {
      if (event === "ade-event") {
        busHandler = handler;
      }
      return Promise.resolve(() => {});
    });

    await act(async () => {
      root?.render(createElement(PoolFailoverNotice));
    });

    expect(busHandler).not.toBeNull();

    const payload: PoolFailoverEvent = {
      taskId: "task-123",
      runId: "run-456",
      poolId: "pool-1",
      poolName: "Devs",
      fromAccount: "acc-1",
      toAccount: "acc-2",
      reason: "rate limit",
      kind: "rate_limited",
    };

    act(() => {
      busHandler?.({
        payload: {
          topic: POOL_FAILOVER_TOPIC,
          data: payload,
        },
      });
    });

    expect(mock.toast).toHaveBeenCalledTimes(1);
    expect(mock.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Devs",
        text: expect.stringContaining("accounts.pools.failover.notice"),
        ms: 8000,
      }),
    );

    // Garante que NENHUMA troca de conta automatica e disparada para terminais interativos
    expect(mock.invoke).not.toHaveBeenCalledWith(
      expect.stringMatching(/switch|set_account|change_account/),
      expect.anything()
    );
  });

  it("ignora eventos com topicos diferentes ou payload sem poolId", async () => {
    let busHandler: ((e: { payload: { topic: string; data: unknown } }) => void) | null = null;
    mock.listen.mockImplementation((event: string, handler: (e: any) => void) => {
      if (event === "ade-event") {
        busHandler = handler;
      }
      return Promise.resolve(() => {});
    });

    await act(async () => {
      root?.render(createElement(PoolFailoverNotice));
    });

    act(() => {
      busHandler?.({
        payload: {
          topic: "outro.evento",
          data: { poolId: "pool-1" },
        },
      });
    });
    expect(mock.toast).not.toHaveBeenCalled();

    act(() => {
      busHandler?.({
        payload: {
          topic: POOL_FAILOVER_TOPIC,
          data: { poolId: "" },
        },
      });
    });
    expect(mock.toast).not.toHaveBeenCalled();
  });
});

