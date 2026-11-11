import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_PREFERENCES_KEY, DEFAULT_BROWSER_PREFERENCES, readBrowserPreferences, saveBrowserPreferences } from "../browserPreferences";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("preferências do navegador", () => {
  it("usa padrões seguros quando ainda não há preferências", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readBrowserPreferences()).toEqual(DEFAULT_BROWSER_PREFERENCES);
  });

  it("persiste o auto-show e limita o máximo de gravação aos valores aceitos", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    saveBrowserPreferences({ autoShowFloatingPreview: false, maxRecordingFps: 60 });
    expect(storage.getItem(BROWSER_PREFERENCES_KEY)).toBe('{"autoShowFloatingPreview":false,"maxRecordingFps":60}');
    expect(readBrowserPreferences()).toEqual({ autoShowFloatingPreview: false, maxRecordingFps: 60 });
    storage.setItem(BROWSER_PREFERENCES_KEY, '{"autoShowFloatingPreview":true,"maxRecordingFps":120}');
    expect(readBrowserPreferences().maxRecordingFps).toBe(30);
  });

  it("tolera JSON corrompido e falhas de armazenamento", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(BROWSER_PREFERENCES_KEY, "{");
    expect(readBrowserPreferences()).toEqual(DEFAULT_BROWSER_PREFERENCES);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    expect(() => saveBrowserPreferences(DEFAULT_BROWSER_PREFERENCES)).toThrow("storage");
  });
});
