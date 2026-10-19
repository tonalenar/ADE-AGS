import { describe, expect, it } from "vitest";
import { BoxIcon, MonitorIcon } from "neogestify-ui-components";

import { agentIcon } from "../agentIcons";
import { CodexIcon, HermesAgentIcon, OpenCodeIcon } from "../brandIcons";
import { AntigravityColorIcon, ClaudeCodeColorIcon, GeminiColorIcon, KimiColorIcon } from "../brandColorIcons";

describe("ícones dos agentes", () => {
  it("cada agente de fábrica tem o logo oficial nas cores originais (nenhum cai no ícone genérico)", () => {
    expect(agentIcon("claude-code")).toBe(ClaudeCodeColorIcon);
    expect(agentIcon("codex")).toBe(CodexIcon);
    expect(agentIcon("antigravity")).toBe(AntigravityColorIcon);
    expect(agentIcon("gemini-cli")).toBe(GeminiColorIcon);
    expect(agentIcon("opencode")).toBe(OpenCodeIcon);
    expect(agentIcon("kimi-code")).toBe(KimiColorIcon);
    expect(agentIcon("hermes")).toBe(HermesAgentIcon);
    expect(agentIcon("bash")).toBe(MonitorIcon);
  });

  it("um agente custom ganha o logo pelo comando; um desconhecido, o genérico", () => {
    expect(agentIcon("meu-agy", "agy --yolo")).toBe(AntigravityColorIcon);
    expect(agentIcon("meu-hermes", "hermes --tui")).toBe(HermesAgentIcon);
    expect(agentIcon("xyz", "minha-tui")).toBe(BoxIcon);
  });
});
