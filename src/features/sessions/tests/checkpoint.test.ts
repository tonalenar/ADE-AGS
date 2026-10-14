import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { buildExtras, PREVIEW_CHARS, PREVIEW_LINES, previewFromLines } from "../checkpoint";

describe("prévia da tela para a lista de conversas", () => {
  it("fica com as últimas linhas, sem vazias nem caracteres de controle", () => {
    const lines = ["", "a\u001b", "  ", ...Array.from({ length: 30 }, (_, i) => `linha ${i}`), ""];
    const preview = previewFromLines(lines)!;
    const parts = preview.split("\n");
    expect(parts).toHaveLength(PREVIEW_LINES);
    expect(parts[parts.length - 1]).toBe("linha 29");
    expect(preview).not.toContain("\u001b");
  });

  it("sem texto devolve nulo, e o corte por caracteres guarda o final", () => {
    expect(previewFromLines(null)).toBeNull();
    expect(previewFromLines(["", "   "])).toBeNull();
    const long = previewFromLines(["x".repeat(PREVIEW_CHARS + 500) + "FIM"])!;
    expect(long.length).toBe(PREVIEW_CHARS);
    expect(long.endsWith("FIM")).toBe(true);
  });
});

describe("checkpoints por aba", () => {
  it("só abas de agente com pasta e sessão identificada entram; o shell puro não é conversa", () => {
    const tabs = [
      { id: "a", agentId: "claude-code", cwd: "C:/p", sessionId: "s1" },
      { id: "b", agentId: "bash", cwd: "C:/p", sessionId: "s2" },
      { id: "c", agentId: "codex", cwd: "", sessionId: "s3" },
      { id: "d", agentId: "claude-code", cwd: "C:/p" },
    ];
    const extras = buildExtras(tabs, (id) => (id === "a" ? ["oi"] : null), () => ({ x: 1, y: 2, w: 3, h: 4 }));
    expect(extras).toEqual([{ tabId: "a", preview: "oi", box: { x: 1, y: 2, w: 3, h: 4 } }]);
  });
});
