import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => fake.invoke(...args),
}));

import { canvasActions, initCanvasSync, useCanvasStore } from "../store";

describe("falha ao salvar canvas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.invoke.mockReset();
    fake.invoke.mockImplementation((command: string) => {
      if (command === "canvas_load") return Promise.resolve({});
      if (command === "canvas_save") return Promise.reject(new Error("sem espaço"));
      return Promise.resolve(undefined);
    });
    useCanvasStore.setState({ boards: {}, loaded: false, loadError: null, saveError: null });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("falha_ao_salvar_avisa", async () => {
    const dispose = initCanvasSync("main");
    await Promise.resolve();
    await Promise.resolve();
    canvasActions.addThread("main|/projeto", "thread:1");
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();

    expect(useCanvasStore.getState().saveError).toContain("sem espaço");
    dispose();
  });
});
