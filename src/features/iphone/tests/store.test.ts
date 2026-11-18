import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  iphoneDevices: vi.fn(),
  iphoneMirrorSessionPaused: vi.fn().mockResolvedValue(false),
  iphoneMirrorStatus: vi.fn().mockResolvedValue(null),
  IPHONE_SESSION_EVENT: "iphone-mirror-session",
  IPHONE_STATUS_EVENT: "iphone-mirror-status",
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { iphoneDevices, type PhysicalList } from "../ipc";
import { applyMirrorStatus, refreshPhysical, useIphoneStore } from "../store";

const phone = { id: "device:phone", name: "iPhone", model: "iPhone 15", os: "27.2", family: "iphone" as const, transport: "wifi" as const, paired: true, developerMode: true, tunnel: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("busca de iPhones", () => {
  beforeEach(() => {
    vi.mocked(iphoneDevices).mockReset();
    useIphoneStore.setState({ devices: [], loaded: false, unavailable: null, discovery: null, statuses: {}, disconnectedDevices: [], panelPick: null });
  });

  it("uma busca manual faz uma consulta fresca depois da varredura periódica em andamento", async () => {
    const first = deferred<PhysicalList>();
    vi.mocked(iphoneDevices).mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ devices: [{ ...phone, name: "iPhone atualizado" }], unavailable: null, error: null });

    const periodic = refreshPhysical();
    const manual = refreshPhysical(true);
    await Promise.resolve();
    expect(iphoneDevices).toHaveBeenCalledTimes(1);

    first.resolve({ devices: [phone], unavailable: null, error: null });
    await Promise.all([periodic, manual]);

    expect(iphoneDevices).toHaveBeenCalledTimes(2);
    expect(useIphoneStore.getState().devices[0]?.name).toBe("iPhone atualizado");
  });

  it("um timeout do devicectl mantém a última lista que a pessoa já via", async () => {
    vi.mocked(iphoneDevices)
      .mockResolvedValueOnce({ devices: [phone], unavailable: null, error: null })
      .mockResolvedValueOnce({ devices: [], unavailable: null, error: { kind: "timeout" } });

    await refreshPhysical();
    await refreshPhysical(true);

    expect(useIphoneStore.getState().devices.map((d) => d.id)).toEqual(["device:phone"]);
    expect(useIphoneStore.getState().discovery).toEqual({ kind: "timeout" });
  });

  it("a falta do Xcode esvazia a lista e guarda o motivo, sem confundir com timeout", async () => {
    vi.mocked(iphoneDevices).mockResolvedValueOnce({ devices: [], unavailable: "xcode", error: { kind: "xcodeMissing" } });

    await refreshPhysical();

    expect(useIphoneStore.getState().devices).toEqual([]);
    expect(useIphoneStore.getState().unavailable).toBe("xcode");
    expect(useIphoneStore.getState().discovery).toEqual({ kind: "xcodeMissing" });
  });
});

describe("estado do espelhamento", () => {
  it("um status nulo (sem sessão) apaga o último ao vivo, que habilitaria o toque", () => {
    applyMirrorStatus("device:phone", { device: "device:phone", state: "live", transport: "wifi", display: null, error: null, input: true, fps: 30 });
    expect(useIphoneStore.getState().statuses["device:phone"]?.state).toBe("live");

    applyMirrorStatus("device:phone", null);

    expect(useIphoneStore.getState().statuses["device:phone"]).toBeUndefined();
  });
});
