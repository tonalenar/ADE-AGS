import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  syncStatus: vi.fn(),
  syncNow: vi.fn(),
  syncSetup: vi.fn(),
  syncDisconnect: vi.fn(),
  syncSetAuto: vi.fn(),
}));
vi.mock("../ipc", () => ipcMock);
vi.mock("../prefs", () => ({ collectPrefs: () => ({}), applyPrefs: vi.fn() }));

import type { SyncStatus } from "../types";
import { useSyncStore } from "../store";

const status = (auto: boolean): SyncStatus => ({ configured: true, accountId: "a", repo: "r", webUrl: null, auto, last: null });

describe("sync store: erro legível", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMock.syncStatus.mockResolvedValue(status(false));
    useSyncStore.setState({ status: status(false), running: false, error: null, report: null });
  });

  it("sync grava a mensagem do erro, não [object Object]", async () => {
    ipcMock.syncNow.mockRejectedValue({ kind: "auth", message: "token expirado" });
    await useSyncStore.getState().sync();
    expect(useSyncStore.getState().error).toBe("token expirado");
  });
});

describe("A496 auto sync pelo store (caminho real)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMock.syncStatus.mockResolvedValue(status(false));
    useSyncStore.setState({ status: status(false), running: false, error: null, report: null });
  });

  it("setAuto que falha grava o erro, relança e mantém o status anterior", async () => {
    ipcMock.syncSetAuto.mockRejectedValue(new Error("keyring travado"));
    await expect(useSyncStore.getState().setAuto(true)).rejects.toThrow("keyring travado");
    expect(useSyncStore.getState().error).toBe("keyring travado");
    expect(useSyncStore.getState().status?.auto).toBe(false);
  });

  it("setAuto que grava recarrega o status", async () => {
    ipcMock.syncSetAuto.mockResolvedValue(undefined);
    ipcMock.syncStatus.mockResolvedValue(status(true));
    await useSyncStore.getState().setAuto(true);
    expect(useSyncStore.getState().status?.auto).toBe(true);
    expect(useSyncStore.getState().error).toBeNull();
  });
});
