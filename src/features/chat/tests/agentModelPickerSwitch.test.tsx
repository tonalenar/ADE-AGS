// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string) => Promise.resolve(command === "harness_capability_matrix" ? [
  ...["chat", "tui"].flatMap((surface) => ["codex", "claude-code"].map((provider) => ({ surface, provider, cells: [
    { capability: "start", claim: { support: "supported", note: "", missing: "" } },
    { capability: "fast_mode", claim: { support: "supported", note: "", missing: "" } },
  ] }))),
] : []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/features/accounts/pools", () => ({ usePools: () => [], poolValue: (name: string) => `pool:${name}` }));
vi.mock("@/features/runs/ipc", () => ({
  getRoster: () => Promise.resolve({ agents: [
    { agentId: "codex", label: "Codex", installed: true, accounts: [], models: [{ id: "gpt-6.1-sol", label: "gpt-6.1-sol", toolcall: null, local: false, costIn: null, costOut: null, context: null, source: "native", availability: "available", reasoningLevels: null, defaultReasoning: null, fastSupported: true }] },
    { agentId: "claude-code", label: "Claude Code", installed: true, accounts: [], models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", toolcall: null, local: false, costIn: null, costOut: null, context: null, source: "native", availability: "available", reasoningLevels: ["ultrathink", "ultracode"], defaultReasoning: null, fastSupported: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", toolcall: null, local: false, costIn: null, costOut: null, context: null, source: "native", availability: "available", reasoningLevels: ["ultrathink", "ultracode"], defaultReasoning: null, fastSupported: false },
    ] },
  ] }),
  refreshRosterModels: () => Promise.reject(new Error("não usado")),
}));

import { AgentModelPicker, EffortMenu } from "../AgentModelPicker";

const AGENTS = [
  { id: "codex", label: "Codex", command: "codex", available: true },
  { id: "claude-code", label: "Claude Code", command: "claude", available: true },
] as never;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("troca de provedor no painel de uma TUI", () => {
  it("mostra Fast para Claude quando matriz e catálogo anunciam suporte", async () => {
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} harnessSurface="chat" value={{ agentId: "claude-code", model: "claude-opus-5-5", effort: null, account: null }}
        speed={{ fast: false, onChange: vi.fn() }} onChange={vi.fn()} />);
    });
    await act(async () => { (host.querySelector("[data-chat-agent-model-picker]") as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.querySelector('[role="group"][aria-label="chat.picker.speedMode"]')).not.toBeNull();
    expect([...document.body.querySelectorAll("button")].some((button) => button.textContent?.includes("chat.picker.fast"))).toBe(true);
  });

  it("desliga uma preferência Fast antiga se o modelo selecionado não a suporta", async () => {
    const speedChange = vi.fn();
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} harnessSurface="chat" value={{ agentId: "claude-code", model: "claude-sonnet-5-5", effort: null, account: null }}
        speed={{ fast: true, onChange: speedChange }} onChange={vi.fn()} />);
      await Promise.resolve();
    });
    expect(speedChange).toHaveBeenCalledWith(false);
    await act(async () => { (host.querySelector("[data-chat-agent-model-picker]") as HTMLButtonElement).click(); });
    expect(document.body.querySelector('[role="group"][aria-label="chat.picker.speedMode"]')).toBeNull();
  });

  it("oferece Ultrathink e Ultracode nos esforços anunciados pelo catálogo Claude", async () => {
    await act(async () => {
      root.render(<EffortMenu agentId="claude-code" model="claude-opus-5-5" account={null} value={null} onChange={vi.fn()} />);
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { (host.querySelector("button[aria-haspopup=menu]") as HTMLButtonElement).click(); });
    const choices = [...document.body.querySelectorAll('[role="menuitemradio"]')].map((option) => option.textContent);
    expect(choices).toContain("chat.effort.ultrathink");
    expect(choices).toContain("chat.effort.ultracode");
  });

  it("não altera o Fast da sessão atual antes da confirmação de troca", async () => {
    const speedChange = vi.fn();
    const onChange = vi.fn();
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} harnessSurface="chat" value={{ agentId: "codex", model: "gpt-6.1-sol", effort: null, account: null }}
        speed={{ fast: true, onChange: speedChange }} onChange={onChange} />);
    });
    await act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLButtonElement).click(); });
    await act(async () => { (document.body.querySelector('[role="tab"][aria-label="Claude Code"]') as HTMLButtonElement).click(); });
    // O popover do seletor sai por portal no <body>.
    const target = [...document.body.querySelectorAll('[role="option"]')].find((option) => option.textContent?.toLowerCase().includes("sonnet")) as HTMLButtonElement;
    await act(async () => { target.click(); });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude-code", model: "claude-sonnet-5-5" }));
    expect(speedChange).not.toHaveBeenCalled();
  });
});
