import { describe, expect, it } from "vitest";

import { clampTimeout, defaultDecisionSettings, urlAfterProviderChange } from "../decisionsModel";

describe("ajustes das decisões em sombra", () => {
  it("nasce desligado, em multilingual, com a Laya local e 800 ms", () => {
    const settings = defaultDecisionSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.provider).toBe("none");
    expect(settings.baseUrl).toBe("http://localhost:8000");
    expect(settings.model).toBe("multilingual");
    expect(settings.timeoutMs).toBe(800);
    expect(settings.memoryApproval).toBe(false);
    expect(settings.dreamTriage).toBe(false);
    expect(settings.fleetGate).toBe(false);
    expect(settings.missionGate).toBe(false);
    expect(settings.keySaved).toBe(false);
  });

  it("troca a URL padrão com o provedor e preserva uma URL escrita à mão", () => {
    expect(urlAfterProviderChange("http://localhost:8000", "laya_studio")).toBe("https://api.laya.studio");
    expect(urlAfterProviderChange("https://api.laya.studio/", "jev")).toBe("https://api.typesafe.ai");
    expect(urlAfterProviderChange("https://laya.interno.exemplo", "laya_local")).toBe("https://laya.interno.exemplo");
  });

  it("segura o timeout no intervalo aceito pelo backend", () => {
    expect(clampTimeout(800)).toBe(800);
    expect(clampTimeout(1)).toBe(50);
    expect(clampTimeout(99_999)).toBe(30_000);
    expect(clampTimeout(Number.NaN)).toBe(800);
  });
});
