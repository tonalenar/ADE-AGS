import { describe, expect, it } from "vitest";

import { DEFAULT_AUTONOMY, getAutonomy, withAutonomy } from "../autonomy";

describe("withAutonomy", () => {
  it("en seguro, Codex aprueba con revisión automática y mantiene su sandbox", () => {
    expect(withAutonomy("codex", "codex", "safe")).toBe("codex --approve-for-me");
  });

  it("en seguro, Antigravity y Gemini solo aprueban ediciones", () => {
    expect(withAutonomy("antigravity", "agy", "safe")).toBe("agy --mode accept-edits");
    expect(withAutonomy("gemini-cli", "gemini", "safe")).toBe("gemini --approval-mode auto_edit");
  });

  it("nunca agrega un modo peligroso", () => {
    for (const id of ["codex", "antigravity", "gemini-cli", "claude-code"]) {
      const out = withAutonomy(id, id, "safe");
      expect(out).not.toMatch(/dangerously|yolo|bypass|skip-permissions/);
    }
  });

  it("en preguntar y en agentes sin flag, el comando queda igual", () => {
    expect(withAutonomy("codex", "codex", "ask")).toBe("codex");
    expect(withAutonomy("claude-code", "claude", "safe")).toBe("claude");
  });

  it("no repite un flag que el comando ya trae", () => {
    expect(withAutonomy("codex", "codex --approve-for-me", "safe")).toBe("codex --approve-for-me");
  });

  it("sin almacenamiento usa el valor por defecto", () => {
    expect(getAutonomy()).toBe(DEFAULT_AUTONOMY);
  });
});
