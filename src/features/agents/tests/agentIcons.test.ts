import { describe, expect, it } from "vitest";
import { BoxIcon, MonitorIcon } from "neogestify-ui-components";

import { agentIcon } from "../agentIcons";
import { AntigravityIcon, ClaudeCodeIcon, CodexIcon, GeminiCliIcon, HermesAgentIcon, KimiIcon, OpenCodeIcon } from "../brandIcons";

describe("ícones dos agentes", () => {
  it("cada agente de fábrica tem o logo oficial (nenhum cai no ícone genérico)", () => {
    expect(agentIcon("claude-code")).toBe(ClaudeCodeIcon);
    expect(agentIcon("codex")).toBe(CodexIcon);
    expect(agentIcon("antigravity")).toBe(AntigravityIcon);
    expect(agentIcon("gemini-cli")).toBe(GeminiCliIcon);
    expect(agentIcon("opencode")).toBe(OpenCodeIcon);
    expect(agentIcon("kimi-code")).toBe(KimiIcon);
    expect(agentIcon("hermes")).toBe(HermesAgentIcon);
    expect(agentIcon("bash")).toBe(MonitorIcon);
  });

  it("um agente custom ganha o logo pelo comando; um desconhecido, o genérico", () => {
    expect(agentIcon("meu-agy", "agy --yolo")).toBe(AntigravityIcon);
    expect(agentIcon("meu-hermes", "hermes --tui")).toBe(HermesAgentIcon);
    expect(agentIcon("xyz", "minha-tui")).toBe(BoxIcon);
  });
});
