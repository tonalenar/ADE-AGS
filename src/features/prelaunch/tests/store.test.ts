import { describe, expect, it, vi } from "vitest";

const listPresets = vi.fn();
vi.mock("../ipc", () => ({
  listPresets: (...args: unknown[]) => listPresets(...args),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
}));

import { usePrelaunchStore } from "../store";

describe("usePrelaunchStore", () => {
  it("falha ao ler os presets fica no estado e a lista não vira 'lida'", async () => {
    listPresets.mockRejectedValueOnce(new Error("disco indisponível"));
    await expect(usePrelaunchStore.getState().load()).rejects.toThrow("disco indisponível");
    // Sem isso, a tela mostrava todo passo como "preset ausente" (A206).
    expect(usePrelaunchStore.getState().loaded).toBe(false);
    expect(usePrelaunchStore.getState().loadError).toContain("disco indisponível");
  });
});
