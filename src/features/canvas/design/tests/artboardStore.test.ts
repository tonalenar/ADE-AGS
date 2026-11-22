import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ storageGet: vi.fn(), storageSet: vi.fn(), storageClear: vi.fn() }));
vi.mock("../designApi", () => ({ designApi: api }));

import {
  FRAME_ERROR_LIMIT, STORAGE_SAVE_MS, applyArtboardStorage, clearArtboardStorage, ensureArtboardStorage, frameErrorsOf, isStorageReady,
  recordFrameError, resetFrameErrors, snapshotOf, storageEpochOf,
} from "../artboardStore";
import { STORAGE_LIMIT_BYTES } from "../artboardBoot";

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("armazenamento de cada prancheta (store)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.storageGet.mockReset().mockResolvedValue({ local: { a: "1" }, session: {} });
    api.storageSet.mockReset().mockResolvedValue({ artboardId: "x", bytes: 0 });
    api.storageClear.mockReset().mockResolvedValue({ artboardId: "x", cleared: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("carrega do backend uma vez e só fica pronta depois da carga", async () => {
    ensureArtboardStorage("art-carga");
    expect(isStorageReady("art-carga")).toBe(false);
    ensureArtboardStorage("art-carga");
    await settle();
    expect(api.storageGet).toHaveBeenCalledTimes(1);
    expect(api.storageGet).toHaveBeenCalledWith("art-carga");
    expect(isStorageReady("art-carga")).toBe(true);
    expect(snapshotOf("art-carga")).toEqual({ local: { a: "1" }, session: {} });
  });

  it("grava no backend com debounce: uma vez, com o estado final", async () => {
    ensureArtboardStorage("art-save");
    await settle();
    applyArtboardStorage("art-save", { kind: "storage", op: "set", area: "local", key: "b", value: "2" });
    applyArtboardStorage("art-save", { kind: "storage", op: "set", area: "local", key: "c", value: "3" });
    expect(api.storageSet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STORAGE_SAVE_MS);
    await settle();
    expect(api.storageSet).toHaveBeenCalledTimes(1);
    expect(api.storageSet).toHaveBeenCalledWith("art-save", { local: { a: "1", b: "2", c: "3" }, session: {} });
  });

  it("uma gravação que passa do limite não muda o estado nem vai ao backend", async () => {
    ensureArtboardStorage("art-quota");
    await settle();
    applyArtboardStorage("art-quota", { kind: "storage", op: "set", area: "local", key: "big", value: "x".repeat(STORAGE_LIMIT_BYTES) });
    vi.advanceTimersByTime(STORAGE_SAVE_MS);
    await settle();
    expect(snapshotOf("art-quota")).toEqual({ local: { a: "1" }, session: {} });
    expect(api.storageSet).not.toHaveBeenCalled();
  });

  it("limpar zera o estado, troca a época (a prancheta recomeça) e apaga no backend", async () => {
    ensureArtboardStorage("art-clear");
    await settle();
    const before = storageEpochOf("art-clear");
    applyArtboardStorage("art-clear", { kind: "storage", op: "set", area: "session", key: "s", value: "1" });
    await clearArtboardStorage("art-clear");
    expect(snapshotOf("art-clear")).toEqual({ local: {}, session: {} });
    expect(storageEpochOf("art-clear")).toBe(before + 1);
    expect(api.storageClear).toHaveBeenCalledWith("art-clear");
    vi.advanceTimersByTime(STORAGE_SAVE_MS);
    await settle();
    expect(api.storageSet).not.toHaveBeenCalled();
  });

  it("erros de script: guarda os últimos, corta a mensagem e zera ao criar um documento novo", () => {
    for (let i = 0; i < FRAME_ERROR_LIMIT + 2; i++) recordFrameError("art-err", { message: `erro ${i} ${"y".repeat(400)}`, line: i });
    const errors = frameErrorsOf("art-err");
    expect(errors).toHaveLength(FRAME_ERROR_LIMIT);
    expect(errors[errors.length - 1]).toMatchObject({ line: FRAME_ERROR_LIMIT + 1 });
    expect(errors[0].message.length).toBeLessThanOrEqual(300);
    resetFrameErrors("art-err");
    expect(frameErrorsOf("art-err")).toEqual([]);
  });
});
