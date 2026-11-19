import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { parseSimulatorPrefs, useSimulatorPrefs } from "../prefs";

describe("preferências do simulador", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useSimulatorPrefs.setState({ light: true, lightMax: false, hibernateMin: 10, single: true });
  });

  it("modo máximo começa desligado por padrão e tolera JSON ausente ou inválido", () => {
    expect(parseSimulatorPrefs(null)).toEqual({ light: true, lightMax: false, hibernateMin: 10, single: true });
    expect(parseSimulatorPrefs("{}")).toEqual({ light: true, lightMax: false, hibernateMin: 10, single: true });
    expect(parseSimulatorPrefs("lixo")).toEqual({ light: true, lightMax: false, hibernateMin: 10, single: true });
    expect(parseSimulatorPrefs(JSON.stringify({ lightMax: "true" }))).toEqual({ light: true, lightMax: false, hibernateMin: 10, single: true });
  });

  it("lê lightMax salvo como true sem alterar os outros padrões", () => {
    expect(parseSimulatorPrefs(JSON.stringify({ lightMax: true }))).toEqual({
      light: true, lightMax: true, hibernateMin: 10, single: true,
    });
  });

  it("propaga lightMax ao backend quando a preferência muda", () => {
    useSimulatorPrefs.getState().set({ lightMax: true });
    expect(useSimulatorPrefs.getState().lightMax).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("simulator_settings", {
      hibernateMinutes: 10,
      single: true,
      light: true,
      lightMax: true,
    });
  });
});
