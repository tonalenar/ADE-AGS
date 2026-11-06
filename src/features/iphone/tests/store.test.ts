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
import { refreshPhysical, useIphoneStore } from "../store";

const phone = { id: "device:phone", name: "iPhone", model: "iPhone 15", os: "27.2", family: "iphone" as const, transport: "wifi" as const, paired: true, developerMode: true, tunnel: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("busca de iPhones", () => {
  beforeEach(() => {
    vi.mocked(iphoneDevices).mockReset();
    useIphoneStore.setState({ devices: [], loaded: false, unavailable: null, statuses: {}, disconnectedDevices: [], panelPick: null });
  });

  it("uma busca manual faz uma consulta fresca depois da varredura periódica em andamento", async () => {
    const first = deferred<PhysicalList>();
    vi.mocked(iphoneDevices).mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ devices: [{ ...phone, name: "iPhone atualizado" }], unavailable: null });

    const periodic = refreshPhysical();
    const manual = refreshPhysical(true);
    await Promise.resolve();
    expect(iphoneDevices).toHaveBeenCalledTimes(1);

    first.resolve({ devices: [phone], unavailable: null });
    await Promise.all([periodic, manual]);

    expect(iphoneDevices).toHaveBeenCalledTimes(2);
    expect(useIphoneStore.getState().devices[0]?.name).toBe("iPhone atualizado");
  });
});
