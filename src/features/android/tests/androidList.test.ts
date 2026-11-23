/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  ANDROID_LIST_BASE_MS,
  ANDROID_LIST_MAX_MS,
  nextAndroidListPollMs,
  useAndroidListStore,
  watchAndroidList,
  type AndroidList,
} from "../ipc";

const sample: AndroidList = {
  adb: true,
  devices: [{ serial: "emulator-5554", state: "device", model: "Pixel 8" }],
  avds: ["Pixel_8"],
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("observador compartilhado de android_list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    useAndroidListStore.setState({ list: null, loaded: false });
    setHidden(false);
  });

  afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
  });

  it("dois assinantes (DevicesPane + DeviceNode) compartilham um único relógio", async () => {
    invoke.mockResolvedValue(sample);
    const stopA = watchAndroidList();
    const stopB = watchAndroidList();

    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useAndroidListStore.getState().list).toEqual(sample);

    // Após 4 s, apenas 1 nova consulta — não 2.
    await vi.advanceTimersByTimeAsync(ANDROID_LIST_BASE_MS);
    expect(invoke).toHaveBeenCalledTimes(2);

    // Parar só o primeiro mantém o segundo vivo.
    stopA();
    await vi.advanceTimersByTimeAsync(ANDROID_LIST_BASE_MS);
    expect(invoke).toHaveBeenCalledTimes(3);

    // Parar o último encerra o relógio.
    stopB();
    await vi.advanceTimersByTimeAsync(ANDROID_LIST_BASE_MS * 3);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("pausa com a janela oculta e faz pull imediato ao voltar visível", async () => {
    invoke.mockResolvedValue(sample);
    const stop = watchAndroidList();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(1);

      setHidden(true);
      await vi.advanceTimersByTimeAsync(ANDROID_LIST_BASE_MS * 5);
      expect(invoke).toHaveBeenCalledTimes(1);

      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("aplica backoff quando android_list falha ou demora sob carga", async () => {
    expect(nextAndroidListPollMs({ elapsedMs: 100, failed: false, streak: 0 })).toBe(ANDROID_LIST_BASE_MS);
    expect(nextAndroidListPollMs({ elapsedMs: 2000, failed: false, streak: 1 })).toBe(8000);
    expect(nextAndroidListPollMs({ elapsedMs: 50, failed: true, streak: 1 })).toBe(8000);
    expect(nextAndroidListPollMs({ elapsedMs: 50, failed: true, streak: 2 })).toBe(16_000);
    expect(nextAndroidListPollMs({ elapsedMs: 50, failed: true, streak: 5 })).toBe(ANDROID_LIST_MAX_MS);

    invoke.mockRejectedValueOnce(new Error("adb timeout")).mockResolvedValue(sample);
    const stop = watchAndroidList();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(1);

      // Com falha, não dispara aos 4 s; espera 8 s de backoff.
      await vi.advanceTimersByTimeAsync(4000);
      expect(invoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4000);
      expect(invoke).toHaveBeenCalledTimes(2);

      // Após recuperar rápido, volta ao ritmo normal de 4 s.
      await vi.advanceTimersByTimeAsync(4000);
      expect(invoke).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });
});
