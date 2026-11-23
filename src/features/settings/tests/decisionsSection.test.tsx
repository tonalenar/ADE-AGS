/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
const listenMock = vi.hoisted(() => ({
  listen: vi.fn<(name: string, cb: (event: { payload: string }) => void) => Promise<() => void>>(
    async () => () => {},
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock.listen }));
const i18nResult = { t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { DecisionsSection } from "../DecisionsSection";
import type { ShadowReport } from "../decisionsIpc";
import { defaultDecisionSettings, type DecisionSettings } from "../decisionsModel";

const settings = (over: Partial<DecisionSettings>): DecisionSettings => ({ ...defaultDecisionSettings(), ...over });

const report: ShadowReport = {
  generatedAt: 1,
  minSample: 30,
  judged: [
    { provider: "jev", decided: 6, correct: 4, wrong: 1, abstained: 1 },
    { provider: "heuristic", decided: 6, correct: 0, wrong: 0, abstained: 6 },
  ],
  comparisons: [
    {
      point: "memory_approval",
      providerA: "jev",
      providerB: "laya_local",
      compared: 5,
      agreementRate: 0.4,
      questions: [{ question: "acao", compared: 5, agreementRate: 0.4, blindRate: 0, blindLabels: [], pairs: [{ heuristic: "revisar", provider: "aprovar", count: 3 }] }],
    },
  ],
  points: [
    {
      point: "memory_approval",
      provider: "laya_local",
      total: 4,
      compared: 4,
      lowSample: true,
      agreementRate: 0.25,
      p50Ms: 10,
      p95Ms: 40,
      errorRate: 0,
      timeoutRate: 0,
      questions: [
        {
          question: "acao",
          compared: 4,
          agreementRate: 0.25,
          blindRate: 0.5,
          blindLabels: ["aprovar"],
          pairs: [{ heuristic: "revisar", provider: "aprovar", count: 2 }],
        },
        { question: "segredo", compared: 4, agreementRate: 0.75, blindRate: 0, blindLabels: [], pairs: [] },
      ],
    },
  ],
  disagreements: [],
};

let host: HTMLDivElement;
let root: Root;

async function mount(current: DecisionSettings) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "decision_settings_get") return current;
    if (cmd === "decision_shadow_report") return report;
    return undefined;
  });
  await act(async () => {
    root.render(<DecisionsSection />);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.listen.mockReset();
  listenMock.listen.mockResolvedValue(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("seção Decisões (experimental)", () => {
  it("avisa que o texto sai da máquina quando o endereço não é local", async () => {
    await mount(settings({ provider: "laya_studio", baseUrl: "https://api.laya.studio" }));
    const note = host.querySelector('[role="note"]');
    expect(note?.textContent).toContain("settings.decisions.remoteWarn");
    expect(note?.textContent).toContain("api.laya.studio");
  });

  it("não avisa com a Laya local, nem com nenhum provedor escolhido", async () => {
    await mount(settings({ provider: "laya_local", baseUrl: "http://localhost:8000" }));
    expect(host.querySelector('[role="note"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(settings({ provider: "none", baseUrl: "https://api.laya.studio" }));
    expect(host.querySelector('[role="note"]')).toBeNull();
  });

  it("troca o modelo ao mudar o provedor e corrige um nome da Laya carregado no Jev", async () => {
    await mount(settings({ provider: "laya_local", model: "english", baseUrl: "http://localhost:8000" }));
    const modelOf = () => host.querySelector<HTMLSelectElement>('select[aria-label="settings.decisions.model"]')!;
    const provider = host.querySelector<HTMLSelectElement>('select[aria-label="settings.decisions.provider"]')!;
    expect(Array.from(modelOf().options).map((option) => option.value)).toEqual([
      "multilingual", "english", "typed-decisions",
    ]);
    expect(modelOf().value).toBe("english");

    const choose = async (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(provider, value);
      await act(async () => { provider.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    await choose("jev");
    expect(Array.from(modelOf().options).map((option) => option.value)).toEqual([
      "jev-latest", "jev-preview", "jev-1.14.0",
    ]);
    expect(modelOf().value).toBe("jev-latest");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="settings.decisions.baseUrl"]')!.value)
      .toBe("https://api.typesafe.ai");

    await choose("laya_studio");
    expect(modelOf().value).toBe("multilingual");
    expect(Array.from(modelOf().options).map((option) => option.value)).toContain("typed-decisions");

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(settings({ provider: "jev", model: "multilingual", baseUrl: "https://api.typesafe.ai" }));
    expect(modelOf().value).toBe("jev-latest");
  });

  it("avisa também quando a \"Laya local\" aponta para um servidor da rede", async () => {
    await mount(settings({ provider: "laya_local", baseUrl: "https://laya.interno.exemplo" }));
    expect(host.querySelector('[role="note"]')?.textContent).toContain("laya.interno.exemplo");
  });

  it("mostra os dois provedores lado a lado quando há propostas consultadas pelos dois", async () => {
    await mount(settings({ provider: "laya_local", secondaryProvider: "jev", secondaryBaseUrl: "https://api.typesafe.ai", secondaryModel: "jev-latest" }));
    const text = host.textContent ?? "";
    expect(text).toContain("settings.decisions.compare.agree");
    expect(text).toContain('"n":5');
    expect(text).toContain("settings.decisions.provider.jev: revisar");
    expect(text).toContain("settings.decisions.provider.layaLocal: aprovar");
    // O destino remoto do segundo provedor também ganha o aviso de privacidade.
    expect(host.querySelector('[role="note"]')?.textContent).toContain("api.typesafe.ai");
  });

  it("mostra quem chegou mais perto da decisão da pessoa, com a heurística como base", async () => {
    await mount(settings({ provider: "laya_local" }));
    const text = host.textContent ?? "";
    expect(text).toContain("settings.decisions.judged.title");
    // Jev: 4 de 5 que respondeu = 80%; a heurística nunca decide (só pede revisão).
    expect(text).toContain('"correct":4,"answered":5,"pct":"80%","abstained":1,"decided":6');
    expect(text).toContain("settings.decisions.judged.heuristic");
    expect(text).toContain('"correct":0,"answered":0,"pct":"—","abstained":6,"decided":6');
  });

  it("só mostra os campos do segundo provedor quando ele está ligado", async () => {
    await mount(settings({ provider: "laya_local" }));
    expect(host.querySelector('input[aria-label*="settings.decisions.compare.provider"]')).toBeNull();
    expect(host.textContent).not.toContain("settings.decisions.compare.same");
  });

  it("mostra a concordância por pergunta, o que só o provedor diz e a amostra pequena", async () => {
    await mount(settings({ provider: "laya_local" }));
    const refresh = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "settings.decisions.refresh");
    await act(async () => refresh?.click());
    const text = host.textContent ?? "";
    expect(text).toContain("settings.decisions.lowSample");
    expect(text).toContain('"have":4');
    expect(text).toContain('"n":30');
    expect(text).toContain("acao");
    expect(text).toContain("segredo");
    expect(text).toContain("settings.decisions.q.blind");
    expect(text).toContain('"labels":"aprovar"');
    expect(text).toContain("revisar → aprovar ×2");
    // A pergunta sem rótulo cego não ganha a frase do "nunca devolve".
    expect(text.match(/settings\.decisions\.q\.blind/g)).toHaveLength(1);
  });

  it("formulário sujo não recarrega quando o modelo sobe sozinho", async () => {
    let onUpdated: ((event: { payload: string }) => void) | undefined;
    listenMock.listen.mockImplementation(async (name, cb) => {
      if (name === "decisions-model-updated") onUpdated = cb;
      return () => {};
    });
    await mount(settings({ provider: "jev", model: "jev-latest", baseUrl: "https://api.typesafe.ai" }));
    const url = host.querySelector<HTMLInputElement>('input[aria-label="settings.decisions.baseUrl"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(url, "https://editado.exemplo");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "decision_settings_get") {
        return settings({ provider: "jev", model: "jev-novo", baseUrl: "https://api.typesafe.ai" });
      }
      if (cmd === "decision_shadow_report") return report;
      if (cmd === "jev_models") return ["jev-latest", "jev-novo"];
      return undefined;
    });
    await act(async () => { onUpdated?.({ payload: "jev-novo" }); });
    expect(url.value).toBe("https://editado.exemplo");
    expect(host.textContent).toContain("settings.decisions.autoUpdatedKeepEdits");
    expect(host.textContent).not.toContain("settings.decisions.autoUpdated ");
  });

  it("testar conexão envia o que está editado na tela, sem depender do SQLite salvo", async () => {
    await mount(settings({ provider: "none", baseUrl: "http://localhost:8000", model: "multilingual", keySaved: false }));
    const provider = host.querySelector<HTMLSelectElement>('select[aria-label="settings.decisions.provider"]')!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(provider, "jev");
    await act(async () => { provider.dispatchEvent(new Event("change", { bubbles: true })); });

    const keyInput = host.querySelector<HTMLInputElement>('input[aria-label="settings.decisions.key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyInput, "sk-teste-rascunho-123456");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const calls: Array<{ cmd: string; args: unknown }> = [];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "decision_test_connection") return { ok: true, latencyMs: 42, error: null };
      return undefined;
    });

    const testBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "settings.decisions.test")!;
    await act(async () => { testBtn.click(); });

    const testCall = calls.find((c) => c.cmd === "decision_test_connection");
    expect(testCall?.args).toEqual({
      slot: "primary",
      draft: {
        provider: "jev",
        baseUrl: "https://api.typesafe.ai",
        model: "jev-latest",
        timeoutMs: 800,
        apiKey: "sk-teste-rascunho-123456",
      },
    });
  });

  it("save grava a chave no keyring antes das flags e não grava flags se o keyring falhar", async () => {
    await mount(settings({ enabled: false, provider: "none", browserPilot: false, keySaved: false }));

    const provider = host.querySelector<HTMLSelectElement>('select[aria-label="settings.decisions.provider"]')!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(provider, "jev");
    await act(async () => { provider.dispatchEvent(new Event("change", { bubbles: true })); });

    const keyInput = host.querySelector<HTMLInputElement>('input[aria-label="settings.decisions.key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyInput, "sk-chave-valida-123456");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Primeiro caso: keyring falha -> decision_settings_set NÃO é chamado.
    const orderFail: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      orderFail.push(cmd);
      if (cmd === "decision_key_set") throw new Error("cofre bloqueado");
      return undefined;
    });

    const saveBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "settings.decisions.save")!;
    await act(async () => { saveBtn.click(); });

    expect(orderFail).toEqual(["decision_key_set"]);
    expect(host.textContent).toContain("cofre bloqueado");

    // Segundo caso: keyring funciona -> decision_key_set vem ANTES de decision_settings_set.
    const orderOk: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      orderOk.push(cmd);
      if (cmd === "decision_settings_set") return settings({ enabled: false, provider: "jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", keySaved: true });
      if (cmd === "decision_settings_get") return settings({ enabled: false, provider: "jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", keySaved: true });
      return undefined;
    });

    await act(async () => { saveBtn.click(); });
    expect(orderOk.indexOf("decision_key_set")).toBe(0);
    expect(orderOk.indexOf("decision_settings_set")).toBe(1);
  });

  it("amarra browserVision a browserPilot na UI: ligar visão liga piloto e desligar piloto desliga visão", async () => {
    await mount(settings({ enabled: true, provider: "jev", browserPilot: false, browserVision: false, keySaved: true }));
    const switchByLabel = (label: string) => {
      const span = Array.from(host.querySelectorAll("span")).find((el) => el.textContent === label && el.id);
      return span ? host.querySelector<HTMLButtonElement>(`button[role="switch"][aria-labelledby="${span.id}"]`) : null;
    };

    const pilotSwitch = switchByLabel("settings.decisions.point.browser")!;
    const visionSwitch = switchByLabel("settings.decisions.point.browserVision")!;
    expect(pilotSwitch.getAttribute("aria-checked")).toBe("false");
    expect(visionSwitch.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("settings.decisions.point.browserVisionRequiresPilot");

    // Ligar visão também liga o piloto.
    await act(async () => { visionSwitch.click(); });
    expect(pilotSwitch.getAttribute("aria-checked")).toBe("true");
    expect(visionSwitch.getAttribute("aria-checked")).toBe("true");

    // Desligar piloto desliga a visão junto.
    await act(async () => { pilotSwitch.click(); });
    expect(pilotSwitch.getAttribute("aria-checked")).toBe("false");
    expect(visionSwitch.getAttribute("aria-checked")).toBe("false");
  });

  it("ativar Jev no navegador em um passo configura e salva sem chamar o Jev (nem gastar saldo)", async () => {
    await mount(settings({ enabled: false, provider: "none", browserPilot: false, keySaved: true }));
    const calls: Array<{ cmd: string; args: unknown }> = [];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "decision_settings_set") {
        return settings({ enabled: true, provider: "jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", browserPilot: true, keySaved: true });
      }
      if (cmd === "decision_settings_get") {
        return settings({ enabled: true, provider: "jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", browserPilot: true, keySaved: true });
      }
      return undefined;
    });

    const quickBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "settings.decisions.quickBrowser.enable")!;
    expect(quickBtn).toBeDefined();
    await act(async () => { quickBtn.click(); });

    const setCall = calls.find((c) => c.cmd === "decision_settings_set");
    expect(setCall).toBeDefined();
    expect((setCall?.args as { input: DecisionSettings }).input).toMatchObject({
      enabled: true,
      provider: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      browserPilot: true,
    });
    // Nunca chama test_connection nem pick_step ao ativar.
    expect(calls.some((c) => c.cmd === "decision_test_connection" || c.cmd === "decision_pick_step")).toBe(false);
  });
});
