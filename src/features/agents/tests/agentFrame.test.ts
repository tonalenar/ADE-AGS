import { describe, expect, it } from "vitest";

import { agentAccent, nodeFrame } from "../agentTile";

describe("cor do agente na borda do terminal", () => {
  it("cada agente tem a sua cor sólida, e o desconhecido tem uma neutra", () => {
    const ids = ["claude-code", "codex", "antigravity", "opencode", "kimi", "shell"];
    const colors = ids.map(agentAccent);
    colors.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/i));
    expect(new Set(colors.slice(0, 5)).size).toBe(5);
    expect(agentAccent("claude-code")).toBe("#d97757");
    expect(agentAccent("gemini-cli")).toBe(agentAccent("antigravity"));
  });

  it("a borda de repouso tem 2 px na cor do agente", () => {
    const frame = nodeFrame("#d97757", false, false);
    expect(frame.startsWith("0 0 0 2px #d97757")).toBe(true);
    expect(frame).not.toContain("--color-glow");
  });

  it("selecionado, engrossa para 2,5 px e ganha um halo da mesma cor", () => {
    const frame = nodeFrame("#d97757", true, false);
    expect(frame.startsWith("0 0 0 2.5px #d97757, 0 0 0 6px color-mix(in oklab, #d97757 24%, transparent)")).toBe(true);
  });

  it("o orquestrador ganha um brilho por fora quando não está selecionado", () => {
    expect(nodeFrame("#d97757", false, true)).toContain("var(--color-glow)");
    expect(nodeFrame("#d97757", true, true)).not.toContain("var(--color-glow)");
  });
});
