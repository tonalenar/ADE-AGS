import { describe, expect, it } from "vitest";

import { withModel } from "../modelFlags";

describe("withModel", () => {
  it("Codex recibe el modelo y el esfuerzo del Squad", () => {
    expect(withModel("codex", "codex", "gpt-6.1-sol", "medium")).toBe("codex -m gpt-6.1-sol -c model_reasoning_effort=medium");
  });

  it("Antigravity y Claude Code usan --model y --effort", () => {
    expect(withModel("antigravity", "agy", "gemini-3.8-flash-high", "high")).toBe("agy --model gemini-3.8-flash-high --effort high");
    expect(withModel("claude-code", "claude", "claude-sonnet-5-5", "medium")).toBe("claude --model claude-sonnet-5-5 --effort medium");
  });

  it("sin modelo ni esfuerzo (automático), el comando queda igual", () => {
    expect(withModel("codex", "codex", null, null)).toBe("codex");
    expect(withModel("codex", "codex", "", undefined)).toBe("codex");
  });

  it("solo modelo o solo esfuerzo también valen", () => {
    expect(withModel("codex", "codex", "gpt-6.1-sol", null)).toBe("codex -m gpt-6.1-sol");
    expect(withModel("codex", "codex", null, "low")).toBe("codex -c model_reasoning_effort=low");
  });

  it("agentes sin flags conocidos no reciben nada", () => {
    expect(withModel("opencode", "opencode", "x", "high")).toBe("opencode");
    expect(withModel("bash", "bash", "x", "high")).toBe("bash");
  });

  it("no repite un flag que el comando ya trae", () => {
    expect(withModel("codex", "codex -m otro", "gpt-6.1-sol", null)).toBe("codex -m otro");
    expect(withModel("antigravity", "agy --effort low", null, "high")).toBe("agy --effort low");
  });

  it("rechaza ids con caracteres de shell (no se pegan en la línea de comando)", () => {
    expect(withModel("codex", "codex", "x; rm -rf /", "high; ls")).toBe("codex");
    expect(withModel("codex", "codex", "a b", null)).toBe("codex");
  });
});
