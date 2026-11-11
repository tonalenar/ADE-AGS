import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_COMMIT_WRITING_PREFERENCES, readCommitWritingPreferences, writeCommitWritingPreferences } from "../writingStyle";

describe("preferências de escrita de commits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("salva e lê estilo, idioma e instruções locais", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const preferences = { mode: "repository" as const, language: "es" as const, customInstructions: "Asunto corto" };
    writeCommitWritingPreferences(preferences);
    expect(readCommitWritingPreferences()).toEqual(preferences);
  });

  it("usa o padrão sem storage legível", () => {
    vi.stubGlobal("localStorage", { getItem: () => "{ inválido" });
    expect(readCommitWritingPreferences()).toEqual(DEFAULT_COMMIT_WRITING_PREFERENCES);
  });
});
