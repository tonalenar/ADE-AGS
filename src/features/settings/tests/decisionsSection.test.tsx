/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
const i18nResult = { t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { DecisionsSection } from "../DecisionsSection";
import type { ShadowReport } from "../decisionsIpc";
import { defaultDecisionSettings, type DecisionSettings } from "../decisionsModel";

const settings = (over: Partial<DecisionSettings>): DecisionSettings => ({ ...defaultDecisionSettings(), ...over });

const report: ShadowReport = {
  generatedAt: 1,
  minSample: 30,
  points: [
    {
      point: "memory_approval",
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

  it("avisa também quando a \"Laya local\" aponta para um servidor da rede", async () => {
    await mount(settings({ provider: "laya_local", baseUrl: "https://laya.interno.exemplo" }));
    expect(host.querySelector('[role="note"]')?.textContent).toContain("laya.interno.exemplo");
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
});
