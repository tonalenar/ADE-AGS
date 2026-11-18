import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({ updateCheck: vi.fn(), updateInstall: vi.fn() }));
vi.mock("../ipc", () => ipcMock);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/app/closeWithSave", () => ({ exitAllWithSave: vi.fn() }));

import { useUpdatesStore } from "../store";

describe("updates store: erro legível", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdatesStore.setState({ phase: "idle", error: null, progress: null });
  });

  it("verificação manual grava a mensagem do erro, não [object Object]", async () => {
    ipcMock.updateCheck.mockRejectedValue({ kind: "network", message: "sem rede" });
    await useUpdatesStore.getState().check({ manual: true });
    expect(useUpdatesStore.getState().error).toBe("sem rede");
    expect(useUpdatesStore.getState().phase).toBe("error");
  });

  it("instalação que falha grava a mensagem do erro", async () => {
    ipcMock.updateInstall.mockRejectedValue({ kind: "disk", message: "disco cheio" });
    await useUpdatesStore.getState().install();
    expect(useUpdatesStore.getState().error).toBe("disco cheio");
  });
});
