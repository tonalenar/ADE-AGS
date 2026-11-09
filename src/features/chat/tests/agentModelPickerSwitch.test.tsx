// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/features/accounts/pools", () => ({ usePools: () => [], poolValue: (name: string) => `pool:${name}` }));
vi.mock("@/features/runs/ipc", () => ({
  getRoster: () => Promise.resolve({ agents: [
    { agentId: "codex", label: "Codex", installed: true, accounts: [], models: [{ id: "gpt-6.1-sol", label: "gpt-6.1-sol", toolcall: null, local: false, costIn: null, costOut: null, context: null, source: "native", availability: "available", reasoningLevels: null, defaultReasoning: null, fastSupported: true }] },
    { agentId: "claude-code", label: "Claude Code", installed: true, accounts: [], models: [{ id: "sonnet", label: "sonnet", toolcall: null, local: false, costIn: null, costOut: null, context: null, source: "native", availability: "available", reasoningLevels: null, defaultReasoning: null }] },
  ] }),
  refreshRosterModels: () => Promise.reject(new Error("não usado")),
}));

import { AgentModelPicker } from "../AgentModelPicker";

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
  it("não altera o Fast da sessão atual antes da confirmação de troca", async () => {
    const speedChange = vi.fn();
    const onChange = vi.fn();
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} value={{ agentId: "codex", model: "gpt-6.1-sol", effort: null, account: null }}
        speed={{ fast: true, onChange: speedChange }} onChange={onChange} />);
    });
    await act(async () => { (host.querySelector("button[aria-haspopup=dialog]") as HTMLButtonElement).click(); });
    await act(async () => { (host.querySelector('[role="tab"][aria-label="Claude Code"]') as HTMLButtonElement).click(); });
    const target = [...host.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes("sonnet")) as HTMLButtonElement;
    await act(async () => { target.click(); });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude-code", model: "sonnet" }));
    expect(speedChange).not.toHaveBeenCalled();
  });
});
