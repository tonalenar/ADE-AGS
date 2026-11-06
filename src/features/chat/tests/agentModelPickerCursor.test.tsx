// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/features/accounts/pools", () => ({ usePools: () => [], poolValue: (n: string) => `pool:${n}` }));
const model = (id: string, label: string) => ({ id, label, toolcall: null, local: false, costIn: null, costOut: null, context: null, source: "native", availability: "available", reasoningLevels: null, defaultReasoning: null });
vi.mock("@/features/runs/ipc", () => ({
  getRoster: () => Promise.resolve({
    agents: [{
      agentId: "cursor", label: "Cursor", installed: true, accounts: [],
      models: [model("auto", "Auto"), model("gpt-5.1-codex-high", "GPT-5.1 Codex High"), model("gpt-5.1-codex-low", "GPT-5.1 Codex Low")],
    }],
  }),
  refreshRosterModels: () => Promise.reject(new Error("não usado")),
}));

import { AgentModelPicker, EffortMenu, hasEffort } from "../AgentModelPicker";

const AGENTS = [{ id: "cursor", label: "Cursor", command: "cursor-agent", available: true } as never];
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("o Cursor no seletor de modelo", () => {
  it("lista os modelos que o `cursor-agent models` informou (cada variante de esforço é um modelo)", async () => {
    await act(async () => { root.render(<AgentModelPicker agents={AGENTS} value={{ agentId: "cursor", model: null, effort: null, account: null }} onChange={() => undefined} />); });
    await act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLElement).click(); });
    const options = [...host.querySelectorAll("[role=option]")].map((o) => o.textContent);
    expect(options.some((o) => o?.includes("GPT-5.1 Codex High"))).toBe(true);
    expect(options.some((o) => o?.includes("GPT-5.1 Codex Low"))).toBe(true);
    expect(options.some((o) => o?.includes("Auto"))).toBe(true);
  });

  it("não inventa o controle de esforço (ele vem no id da variante) e diz por quê", async () => {
    expect(hasEffort("cursor")).toBe(false);
    await act(async () => { root.render(<EffortMenu agentId="cursor" model={null} account={null} value={null} onChange={() => undefined} />); });
    expect(host.innerHTML).toBe("");
    await act(async () => { root.render(<AgentModelPicker agents={AGENTS} value={{ agentId: "cursor", model: null, effort: null, account: null }} onChange={() => undefined} />); });
    await act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLElement).click(); });
    expect(host.textContent).toContain("chat.picker.cursorEffort");
  });
});

describe("a conta da conversa aberta", () => {
  it("fica dentro do seletor de agente/modelo, no rodapé do popover, e não solta ao lado dele", async () => {
    const slot = <div data-testid="conta">conta principal</div>;
    await act(async () => { root.render(<AgentModelPicker agents={AGENTS} showAccount={false} accountSlot={slot} value={{ agentId: "cursor", model: null, effort: null, account: null }} onChange={() => undefined} />); });
    // Fechado: a conta não aparece na linha do composer.
    expect(host.querySelector("[data-testid=conta]")).toBeNull();
    await act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLElement).click(); });
    const conta = host.querySelector("[data-testid=conta]");
    expect(conta).not.toBeNull();
    // Dentro do mesmo popover dos modelos.
    expect(conta!.closest("[role=dialog]")).not.toBeNull();
    expect(conta!.closest("[role=dialog]")!.querySelector("[role=option]")).not.toBeNull();
  });
});
