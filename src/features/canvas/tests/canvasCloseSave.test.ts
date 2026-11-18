import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => fake.invoke(...args),
}));

import { canvasActions, flushCanvasSavesForClose, useCanvasStore } from "../store";

describe("salvamento do canvas ao fechar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.invoke.mockClear();
    useCanvasStore.setState({ boards: {}, loaded: true, loadError: null, saveError: null });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("flush_do_fechamento_grava_sem_esperar_o_debounce", async () => {
    canvasActions.addThread("main|/projeto", "thread:1");

    await flushCanvasSavesForClose();

    expect(fake.invoke).toHaveBeenCalledWith("canvas_save", expect.objectContaining({ key: "main|/projeto" }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
