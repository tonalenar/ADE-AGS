import { describe, expect, it } from "vitest";

import { clampTimeout, defaultDecisionSettings, isDirty, isLocalUrl, sendsOffMachine, urlAfterProviderChange, urlHost } from "../decisionsModel";

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

  it("só diz que mudou quando algo além da chave do cofre mudou", () => {
    const base = defaultDecisionSettings();
    expect(isDirty(base, { ...base })).toBe(false);
    expect(isDirty(base, { ...base, keySaved: true })).toBe(false);
    expect(isDirty({ ...base, timeoutMs: 2000 }, base)).toBe(true);
    expect(isDirty({ ...base, fleetGate: true }, base)).toBe(true);
  });

  it("separa o que fica nesta máquina do que sai dela, pelo endereço", () => {
    expect(isLocalUrl("http://localhost:8000")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8000/")).toBe(true);
    expect(isLocalUrl("http://[::1]:8000")).toBe(true);
    expect(isLocalUrl("https://api.laya.studio")).toBe(false);
    expect(isLocalUrl("https://laya.interno.exemplo")).toBe(false);
    expect(isLocalUrl("isto não é uma url")).toBe(false);
    expect(urlHost("https://api.typesafe.ai/v1")).toBe("api.typesafe.ai");
    expect(urlHost("")).toBeNull();
  });

  it("só avisa de privacidade com um provedor escolhido e o endereço de fora", () => {
    expect(sendsOffMachine({ provider: "none", baseUrl: "https://api.laya.studio" })).toBe(false);
    expect(sendsOffMachine({ provider: "laya_local", baseUrl: "http://localhost:8000" })).toBe(false);
    expect(sendsOffMachine({ provider: "laya_studio", baseUrl: "https://api.laya.studio" })).toBe(true);
    expect(sendsOffMachine({ provider: "laya_local", baseUrl: "https://laya.interno.exemplo" })).toBe(true);
  });
});
