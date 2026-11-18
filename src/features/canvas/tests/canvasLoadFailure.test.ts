import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => fake.invoke(...args),
}));

import { canvasActions, initCanvasSync, useCanvasStore } from "../store";
import { useTabsStore } from "@/features/tabs/store";

describe("falha ao carregar canvas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.invoke.mockReset();
    fake.invoke.mockImplementation((command: string) => {
      if (command === "canvas_load") return Promise.reject(new Error("arquivo ilegível; cópia em canvas.json.corrupt-123"));
      return Promise.resolve(undefined);
    });
    useCanvasStore.setState({ boards: {}, loaded: false, loadError: null, saveError: null });
    useTabsStore.setState({ tabs: [], hydrated: false });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("load_falho_nao_salva", async () => {
    const dispose = initCanvasSync("main");
    await Promise.resolve();
    await Promise.resolve();
    useTabsStore.setState({ hydrated: true });
    canvasActions.addThread("main|/projeto", "thread:1");
    await vi.advanceTimersByTimeAsync(300);

    expect(fake.invoke).not.toHaveBeenCalledWith("canvas_save", expect.anything());
    expect(useCanvasStore.getState().loadError).toContain("canvas.json.corrupt-123");
    dispose();
  });
});
