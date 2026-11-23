import { describe, expect, it } from "vitest";

import { effectiveEffort, effectiveRole, linkEffortSupported, SUBAGENT_ROLE } from "../linkFormModel";

describe("«Ligar ao time»: subagente", () => {
  it("com o subagente ligado o papel vira o de apoio; desligado, volta o escolhido", () => {
    expect(effectiveRole("reviewer", true)).toBe(SUBAGENT_ROLE);
    expect(effectiveRole("reviewer", false)).toBe("reviewer");
  });
  it("subagente novo nasce em esforço baixo, sem escolha da pessoa", () => {
    expect(effectiveEffort({ effort: null, touched: false, subagent: true, agentId: "claude-code" })).toBe("low");
  });
  it("a escolha da pessoa vale, inclusive o padrão", () => {
    expect(effectiveEffort({ effort: "high", touched: true, subagent: true, agentId: "codex" })).toBe("high");
    expect(effectiveEffort({ effort: null, touched: true, subagent: true, agentId: "codex" })).toBeNull();
  });
  it("quem não é subagente, ou o agente sem esforço, fica como estava", () => {
    expect(effectiveEffort({ effort: null, touched: false, subagent: false, agentId: "codex" })).toBeNull();
    expect(effectiveEffort({ effort: null, touched: false, subagent: true, agentId: "gemini-cli" })).toBeNull();
  });
});

describe("esforço do OpenCode (variant)", () => {
  it("o OpenCode tem esforço selecionável", () => {
    expect(linkEffortSupported("opencode")).toBe(true);
    expect(linkEffortSupported("gemini-cli")).toBe(false);
  });
});
