import { describe, expect, it } from "vitest";

import { recruitCommand } from "../recruitCommand";

describe("recruitCommand", () => {
  it("aplica modelo e esforço pedidos ao Codex recrutado", () => {
    const cmd = recruitCommand("codex", "codex", "ask", "gpt-6.1-luna", "max");
    expect(cmd).toContain("-m gpt-6.1-luna");
    expect(cmd).toContain("model_reasoning_effort=max");
  });

  it("com permissões 'safe' o recrutado recebe a flag segura, como os do time", () => {
    expect(recruitCommand("codex", "codex", "safe")).toContain("--approve-for-me");
    expect(recruitCommand("codex", "codex", "ask")).not.toContain("--approve-for-me");
  });

  it("sem modelo nem esforço não acrescenta nada (fica o padrão da TUI)", () => {
    expect(recruitCommand("codex", "codex", "ask")).toBe("codex");
  });

  it("rejeita um modelo com caracteres perigosos", () => {
    expect(recruitCommand("codex", "codex", "ask", "x; rm -rf /", null)).toBe("codex");
  });
});
