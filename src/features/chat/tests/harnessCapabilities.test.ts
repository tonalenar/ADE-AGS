import { describe, expect, it } from "vitest";

import { capabilityAvailability, goalPauseResumeAvailable, isLegacyGoalClearAlias, legacyComposerCapabilityAvailable, matrixProviderForAgent } from "../harnessCapabilities";

describe("capabilityAvailability", () => {
  it("marca Unsupported como indisponível e preserva a nota da matriz", () => {
    expect(capabilityAvailability("unsupported", "sem caminho nesta superfície")).toEqual({
      support: "unsupported",
      available: false,
      reason: "sem caminho nesta superfície",
      loading: false,
    });
  });

  it("mantém Unknown disponível sem inventar uma razão de bloqueio", () => {
    expect(capabilityAvailability("unknown", "falta uma captura real")).toEqual({
      support: "unknown",
      available: true,
      reason: null,
      loading: false,
    });
    expect(capabilityAvailability("unknown", "", true).loading).toBe(true);
  });

  it("consulta o mesmo registro para qualquer id ACP local", () => {
    expect(matrixProviderForAgent("local-acp-123")).toBe("local-acp");
    expect(matrixProviderForAgent("codex")).toBe("codex");
  });

  it("preserva no registro os comandos TUI cuja célula contradiz o uso atual", () => {
    expect(legacyComposerCapabilityAvailable("tui", "codex", "compact")).toBe(true);
    expect(legacyComposerCapabilityAvailable("tui", "claude-code", "compact")).toBe(true);
    expect(legacyComposerCapabilityAvailable("tui", "claude-code", "goal")).toBe(true);
    expect(legacyComposerCapabilityAvailable("tui", "codex", "goal")).toBe(false);
    expect(legacyComposerCapabilityAvailable("chat", "claude-code", "autocompact")).toBe(true);
    expect(legacyComposerCapabilityAvailable("tui", "claude-code", "autocompact")).toBe(true);
    expect(legacyComposerCapabilityAvailable("chat", "codex", "compact")).toBe(false);
    expect(legacyComposerCapabilityAvailable("tui", "opencode", "compact")).toBe(false);
  });

  it("mantém os aliases de limpeza do Claude sem espalhar a comparação no componente", () => {
    expect(isLegacyGoalClearAlias("claude-code", "stop")).toBe(true);
    expect(isLegacyGoalClearAlias("claude-code", "cancel")).toBe(true);
    expect(isLegacyGoalClearAlias("codex", "stop")).toBe(false);
    expect(isLegacyGoalClearAlias("claude-code", "continue")).toBe(false);
  });

  it("preserva o recorte de pause/resume que não tem célula própria na matriz", () => {
    expect(goalPauseResumeAvailable("codex")).toBe(true);
    expect(goalPauseResumeAvailable("claude-code")).toBe(false);
    expect(goalPauseResumeAvailable(null)).toBe(false);
  });
});
