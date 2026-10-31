import { describe, expect, it } from "vitest";

import { accessModesFor, PROTOCOL_AGENTS, planSupported } from "@/features/chat/chatModel";
import { STRUCTURED_AGENTS } from "@/features/chat/structured/model";

describe("agentes por protocolo (espelho de conversa::api::Engine)", () => {
  it("os quatro agentes falam por protocolo, e os outros seguem na TUI", () => {
    expect([...STRUCTURED_AGENTS].sort()).toEqual(["antigravity", "claude-code", "codex", "opencode"]);
    expect(STRUCTURED_AGENTS.has("gemini-cli")).toBe(false);
  });

  it("por protocolo o OpenCode e o Antigravity têm os quatro acessos e o Plano", () => {
    for (const id of ["opencode", "antigravity"]) {
      expect(accessModesFor(id, true)).toEqual(["ask", "edits", "safe", "full"]);
      expect(planSupported(id, true)).toBe(true);
    }
  });

  it("na TUI esses agentes continuam com os flags da TUI", () => {
    expect(planSupported("opencode")).toBe(false);
    expect(accessModesFor("opencode")).toEqual(["ask"]);
    // O Antigravity já recebe --dangerously-skip-permissions na TUI; ali só Supervisionado.
    expect(accessModesFor("antigravity")).toEqual(["ask"]);
  });

  it("o Codex segue sem Plano e sem Aceitar edições, o Claude Code com tudo", () => {
    expect(planSupported("codex", true)).toBe(false);
    expect(accessModesFor("codex", true)).toEqual(["ask", "safe", "full"]);
    expect(accessModesFor("claude-code", true)).toEqual(["ask", "edits", "safe", "full"]);
    expect(PROTOCOL_AGENTS["claude-code"]?.plan).toBe(true);
  });

  it("um agente fora da tabela cai nos flags da TUI mesmo pedindo protocolo", () => {
    expect(accessModesFor("gemini-cli", true)).toEqual(accessModesFor("gemini-cli"));
    expect(planSupported("gemini-cli", true)).toBe(false);
  });
});
