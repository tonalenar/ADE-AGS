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
import {
  applyMirrorStatus,
  nextPhysicalPollMs,
  PHYSICAL_FAST_POLL_MS,
  PHYSICAL_FAST_WINDOW_MS,
  PHYSICAL_MAX_POLL_MS,
  PHYSICAL_STEADY_POLL_MS,
  refreshPhysical,
  useIphoneStore,
  watchPhysical,
} from "../store";

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

describe("backoff do devicectl", () => {
  beforeEach(() => {
    vi.mocked(iphoneDevices).mockReset();
    useIphoneStore.setState({ devices: [], loaded: false, unavailable: null, discovery: null, statuses: {}, disconnectedDevices: [], panelPick: null });
  });

  it("usa 2 s nos primeiros 20 s, 10 s depois, e desacelera quando a chamada demora ou dá timeout", () => {
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: 0, lastDurationMs: 300, timedOut: false, timeoutStreak: 0 })).toBe(PHYSICAL_FAST_POLL_MS);
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: PHYSICAL_FAST_WINDOW_MS - 1, lastDurationMs: 400, timedOut: false, timeoutStreak: 0 })).toBe(PHYSICAL_FAST_POLL_MS);
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: PHYSICAL_FAST_WINDOW_MS, lastDurationMs: 400, timedOut: false, timeoutStreak: 0 })).toBe(PHYSICAL_STEADY_POLL_MS);

    // Chamada lenta (> 1 s) mesmo dentro dos 20 s já recua para >= 8 s.
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: 2000, lastDurationMs: 1500, timedOut: false, timeoutStreak: 0 })).toBe(8000);
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: 2000, lastDurationMs: 3000, timedOut: false, timeoutStreak: 0 })).toBe(12_000);

    // Timeouts seguidos sobem exponencialmente até o teto de 30 s.
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: 2000, lastDurationMs: 5000, timedOut: true, timeoutStreak: 1 })).toBe(10_000);
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: 2000, lastDurationMs: 5000, timedOut: true, timeoutStreak: 2 })).toBe(20_000);
    expect(nextPhysicalPollMs({ elapsedSinceStartMs: 2000, lastDurationMs: 5000, timedOut: true, timeoutStreak: 3 })).toBe(PHYSICAL_MAX_POLL_MS);
  });

  it("watchPhysical faz backoff após 20 s e pausa quando o documento está oculto", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    let hidden = false;
    const fakeDocument = {
      get visibilityState() { return hidden ? "hidden" : "visible"; },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal("document", fakeDocument);
    const setHidden = (next: boolean) => {
      hidden = next;
      listeners.forEach((fn) => fn());
    };
    try {
      vi.mocked(iphoneDevices).mockResolvedValue({ devices: [phone], unavailable: null, error: null });
      const stop = watchPhysical();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(iphoneDevices).toHaveBeenCalledTimes(1);

        // Nos primeiros 20 s roda a cada 2 s.
        await vi.advanceTimersByTimeAsync(2000);
        expect(iphoneDevices).toHaveBeenCalledTimes(2);

        // Passados 20 s (já avançou 2 s, avança +18 s = 9 ticks), entra em ritmo de 10 s.
        await vi.advanceTimersByTimeAsync(18_000);
        const callsAt20s = vi.mocked(iphoneDevices).mock.calls.length;
        await vi.advanceTimersByTimeAsync(6000);
        expect(iphoneDevices).toHaveBeenCalledTimes(callsAt20s);
        await vi.advanceTimersByTimeAsync(4000);
        expect(iphoneDevices).toHaveBeenCalledTimes(callsAt20s + 1);

        // Com a janela oculta, pausa completamente.
        const beforeHide = vi.mocked(iphoneDevices).mock.calls.length;
        setHidden(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(iphoneDevices).toHaveBeenCalledTimes(beforeHide);

        // Ao voltar visível, dispara leitura imediata.
        setHidden(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(iphoneDevices).toHaveBeenCalledTimes(beforeHide + 1);
      } finally {
        stop();
      }
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
