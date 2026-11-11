// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string) => Promise.resolve(command === "harness_capability_matrix" ? [
  { surface: "tui", provider: "claude-code", cells: [{ capability: "fast_mode", claim: { support: "supported", note: "", missing: "" } }] },
] : []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@/features/accounts/pools", () => ({ usePools: () => [], poolValue: (name: string) => `pool:${name}` }));
vi.mock("@/features/runs/ipc", () => {
  const row = (id: string, label: string, aliases: string[], reasoningLevels: string[], fastSupported = false) => ({
    id, label, aliases, toolcall: null, local: false, costIn: null, costOut: null, context: 1_000_000,
    source: "claude_builtin", availability: "unknown", reasoningLevels, defaultReasoning: "medium", fastSupported, unavailable: null,
  });
  return {
    getRoster: () => Promise.resolve({ agents: [{ agentId: "claude-code", label: "Claude Code", installed: true, accounts: [], models: [
      row("claude-haiku-5-5", "Claude Haiku 5.5", ["haiku"], ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"]),
      row("claude-haiku-4-5", "Claude Haiku 4.5", [], []),
      row("claude-opus-5-5", "Claude Opus 5.5", ["opus"], ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"], true),
    ] }] }),
    refreshRosterModels: () => Promise.reject(new Error("não usado")),
  };
});

import { AgentModelPicker } from "../AgentModelPicker";

const AGENTS = [{ id: "claude-code", label: "Claude Code", command: "claude", available: true }] as never;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const trigger = () => host.querySelector("button[aria-haspopup=dialog]") as HTMLButtonElement;

describe("Claude no seletor do composer", () => {
  it("a pílula mostra o nome com versão quando o modelo salvo é um alias", async () => {
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} value={{ agentId: "claude-code", model: "opus", effort: null, account: null }} onChange={() => undefined} />);
    });
    await act(async () => {});
    expect(trigger().textContent).toBe("Claude Opus 5.5");
  });

  it("o esforço do alias é o do modelo que ele resolve: Haiku tem 3 níveis, não os 5 padrão", async () => {
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} permission={{ value: "ask", modes: ["ask"] }}
        value={{ agentId: "claude-code", model: "haiku", effort: null, account: null }} onChange={() => undefined} />);
    });
    await act(async () => {});
    await act(async () => { trigger().click(); });
    // O padrão + os sete níveis do Haiku 5.5, incluindo Ultracode e Ultrathink.
    expect(document.body.querySelectorAll('[role="radiogroup"] [role="radio"]')).toHaveLength(8);
  });

  it("o modelo padrão resolve os níveis para Opus e explica o custo do Ultracode", async () => {
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} permission={{ value: "ask", modes: ["ask"] }}
        speed={{ fast: false, onChange: () => undefined }}
        value={{ agentId: "claude-code", model: null, effort: "ultracode", account: null }} onChange={() => undefined} />);
    });
    await act(async () => {});
    await act(async () => { trigger().click(); });
    expect(document.body.querySelectorAll('[role="radiogroup"] [role="radio"]')).toHaveLength(8);
    expect(document.body.querySelector('[role="note"]')?.textContent).toBe("chat.picker.ultracodeWarning");
    expect([...document.body.querySelectorAll('[role="radio"]')].find((radio) => radio.textContent?.includes("chat.effort.ultracode"))?.textContent).toContain("models.effort.ultracodeHint");
    expect(document.body.querySelector('[aria-label="chat.picker.speedMode"]')).not.toBeNull();
  });

  it("não escolhe Ultracode sozinho", async () => {
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} permission={{ value: "ask", modes: ["ask"] }}
        value={{ agentId: "claude-code", model: null, effort: null, account: null }} onChange={() => undefined} />);
    });
    await act(async () => {});
    await act(async () => { trigger().click(); });
    const radios = [...document.body.querySelectorAll('[role="radiogroup"] [role="radio"]')];
    expect(radios.find((radio) => radio.textContent?.includes("chat.effort.default"))?.getAttribute("aria-checked")).toBe("true");
    expect(radios.find((radio) => radio.textContent?.includes("chat.effort.ultracode"))?.getAttribute("aria-checked")).toBe("false");
  });

  it("não oferece modos especiais em um modelo fora dos perfis T3", async () => {
    await act(async () => {
      root.render(<AgentModelPicker agents={AGENTS} permission={{ value: "ask", modes: ["ask"] }}
        value={{ agentId: "claude-code", model: "claude-haiku-4-5", effort: null, account: null }} onChange={() => undefined} />);
    });
    await act(async () => {});
    await act(async () => { trigger().click(); });
    expect(document.body.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.body.textContent).not.toContain("chat.effort.ultracode");
  });
});
