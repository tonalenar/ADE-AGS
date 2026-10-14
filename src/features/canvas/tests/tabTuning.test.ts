import { describe, expect, it } from "vitest";

import { readTuning, retune, tuningChanged } from "../tabTuning";

describe("ajuste de esforço e Fast de um terminal aberto", () => {
  it("lê modelo, esforço e Fast do comando do Codex", () => {
    const command = "codex -m gpt-6.1-sol -c model_reasoning_effort=high -c service_tier=fast";
    expect(readTuning("codex", command)).toEqual({ model: "gpt-6.1-sol", effort: "high", fast: true });
  });

  it("lê o esforço do Claude Code e ignora Fast fora do Codex", () => {
    expect(readTuning("claude-code", "claude --model opus --effort max")).toEqual({ model: "opus", effort: "max", fast: false });
    expect(readTuning("claude-code", "claude")).toEqual({ model: null, effort: null, fast: false });
  });

  it("troca o esforço sem duplicar flags e mantém o modelo", () => {
    const next = retune("claude-code", "claude --permission-mode auto --model opus --effort high", { effort: "max", fast: false });
    expect(next).toBe("claude --permission-mode auto --model opus --effort max");
    expect(next.match(/--effort/g)).toHaveLength(1);
  });

  it("liga e desliga o Fast do Codex trocando os flags certos", () => {
    const base = "codex -m gpt-6.1-sol -c model_reasoning_effort=medium -c features.fast_mode=false";
    const on = retune("codex", base, { effort: "medium", fast: true });
    expect(on).toContain("service_tier=fast");
    expect(on).not.toContain("features.fast_mode=false");
    expect(on).toContain("-m gpt-6.1-sol");
    const off = retune("codex", on, { effort: "high", fast: false });
    expect(off).toContain("model_reasoning_effort=high");
    expect(off).toContain("features.fast_mode=false");
    expect(off).not.toContain("service_tier=fast");
    expect(off.match(/model_reasoning_effort/g)).toHaveLength(1);
  });

  it("sem esforço escolhido, tira o esforço do comando", () => {
    expect(retune("claude-code", "claude --effort high", { effort: null, fast: false })).toBe("claude");
  });

  it("detecta se algo mudou", () => {
    const before = readTuning("codex", "codex -c model_reasoning_effort=high");
    expect(tuningChanged(before, "high", false)).toBe(false);
    expect(tuningChanged(before, "max", false)).toBe(true);
    expect(tuningChanged(before, "high", true)).toBe(true);
  });
});
