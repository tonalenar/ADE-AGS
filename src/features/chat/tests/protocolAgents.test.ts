import { describe, expect, it } from "vitest";

import { accessModesFor, fastModeSupported, planSupported, reasoningEffortSupported } from "@/features/chat/chatModel";
import { STRUCTURED_AGENTS } from "@/features/chat/structured/model";

describe("agentes por protocolo (espelho de conversa::api::Engine)", () => {
  it("os cinco agentes falam por protocolo, e os outros seguem na TUI", () => {
    expect([...STRUCTURED_AGENTS].sort()).toEqual(["antigravity", "claude-code", "codex", "cursor", "opencode"]);
    expect(STRUCTURED_AGENTS.has("gemini-cli")).toBe(false);
  });

  it("Fast desconhecido conserva o caminho legado até a matriz carregar; raciocínio segue a TUI", () => {
    expect(fastModeSupported("codex")).toBe(true);
    expect(fastModeSupported("claude-code")).toBe(true);
    expect(reasoningEffortSupported("antigravity")).toBe(true);
    expect(reasoningEffortSupported("opencode")).toBe(false);
  });

  it("por protocolo o OpenCode e o Antigravity têm os quatro acessos e o Plano", () => {
    for (const id of ["opencode", "antigravity"]) {
      expect(accessModesFor(id, true)).toEqual(["ask", "edits", "safe", "full"]);
      expect(planSupported(id, true, "supported")).toBe(true);
    }
  });

  it("o Cursor por protocolo tem Supervisionado, Acesso total e o Plano; Aceitar edições e Auto não têm flag documentada", () => {
    expect(accessModesFor("cursor", true)).toEqual(["ask", "full"]);
    expect(planSupported("cursor", true, "supported")).toBe(true);
    // Na TUI continua o que sempre foi.
    expect(planSupported("cursor", false, "unsupported")).toBe(false);
  });

  it("na TUI esses agentes continuam com os flags da TUI", () => {
    expect(planSupported("opencode", false, "unsupported")).toBe(false);
    expect(accessModesFor("opencode")).toEqual(["ask"]);
    // O Antigravity já recebe --dangerously-skip-permissions na TUI; ali só Supervisionado.
    expect(accessModesFor("antigravity")).toEqual(["ask"]);
  });

  it("o Codex segue sem Plano e sem Aceitar edições, o Claude Code com tudo", () => {
    expect(planSupported("codex", true, "unsupported")).toBe(false);
    expect(accessModesFor("codex", true)).toEqual(["ask", "safe", "full"]);
    expect(accessModesFor("claude-code", true)).toEqual(["ask", "edits", "safe", "full"]);
  });

  it("um agente fora da tabela cai nos flags da TUI mesmo pedindo protocolo", () => {
    expect(accessModesFor("gemini-cli", true)).toEqual(accessModesFor("gemini-cli"));
    expect(planSupported("gemini-cli", true, "unsupported")).toBe(false);
    expect(planSupported("claude-code", false, "unknown")).toBe(false);
  });
});
