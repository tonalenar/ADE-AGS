/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ipcMock = vi.hoisted(() => ({
  memorySyncStatus: vi.fn(),
  memorySyncSetup: vi.fn(),
  memorySyncSetEnabled: vi.fn(),
  memorySyncSetAuto: vi.fn(),
  memorySyncNow: vi.fn(),
}));

const tabsMock = vi.hoisted(() => ({
  workspaceId: "w1" as string | null,
  activeTabId: "t1",
  tabs: [{ id: "t1", cwd: "/repo/projeto" }],
}));

vi.mock("@/features/memorySync/ipc", () => ipcMock);
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: (sel: (s: typeof tabsMock) => unknown) => sel(tabsMock),
}));

import { MemorySyncRunner, msUntilNextMemorySync } from "../MemorySyncRunner";
import { useMemorySyncStore } from "../store";
import type { MemorySyncStatus } from "../types";

const statusWith = (overrides: Partial<MemorySyncStatus> = {}): MemorySyncStatus => ({
  enabled: false,
  configured: false,
  accountId: null,
  repo: null,
  webUrl: null,
  autoEnabled: false,
  intervalHours: 6,
  last: null,
  lastError: null,
  ...overrides,
});

describe("MemorySyncRunner", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useMemorySyncStore.setState({ status: null, running: false, error: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("não agenda nem dispara envio quando desligado", async () => {
    ipcMock.memorySyncStatus.mockResolvedValue(
      statusWith({ enabled: false, configured: true, autoEnabled: true, intervalHours: 1 }),
    );

    await act(async () => {
      root.render(<MemorySyncRunner />);
    });
    await act(async () => {
      vi.advanceTimersByTime(2 * 3600_000);
    });

    expect(ipcMock.memorySyncNow).not.toHaveBeenCalled();
  });

  it("calcula corretamente o atraso restante até o próximo envio automático", () => {
    expect(msUntilNextMemorySync(statusWith({ enabled: true, configured: true, autoEnabled: false }), 1000, null)).toBeNull();
    const delay = msUntilNextMemorySync(
      statusWith({
        enabled: true,
        configured: true,
        autoEnabled: true,
        intervalHours: 6,
        last: {
          at: 1000,
          pushed: true,
          commit: "abc",
          aiMemoryPages: 1,
          sqliteEntries: 0,
          sqliteRevisions: 0,
          skippedPages: [],
          aiMemoryNote: null,
        },
      }),
      (1000 + 3600) * 1000,
      null,
    );
    expect(delay).toBe(5 * 3600_000);
  });

  it("dispara envio automático quando o intervalo expirou e está ligado", async () => {
    vi.setSystemTime(new Date(1_700_050_000 * 1000));
    const ready = statusWith({
      enabled: true,
      configured: true,
      accountId: "acc1",
      repo: "ton/ade-memoria",
      autoEnabled: true,
      intervalHours: 2,
      last: {
        at: 1_700_000_000,
        pushed: true,
        commit: "abc",
        aiMemoryPages: 1,
        sqliteEntries: 0,
        sqliteRevisions: 0,
        skippedPages: [],
        aiMemoryNote: null,
      },
    });
    const updated = statusWith({
      ...ready,
      last: { ...ready.last!, at: 1_700_050_000 },
    });
    ipcMock.memorySyncStatus.mockResolvedValue(ready);
    ipcMock.memorySyncNow.mockResolvedValue({ status: updated, report: updated.last! });

    await act(async () => {
      root.render(<MemorySyncRunner />);
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(ipcMock.memorySyncNow).toHaveBeenCalledWith("w1", "/repo/projeto");
  });
});
