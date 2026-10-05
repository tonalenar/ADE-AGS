import { describe, expect, it } from "vitest";

import { DEFAULT_AUTONOMY, getAutonomy, withAutonomy } from "../autonomy";

describe("withAutonomy", () => {
  it("en seguro, Codex aprueba con revisión automática y mantiene su sandbox", () => {
    expect(withAutonomy("codex", "codex", "safe")).toBe("codex --approve-for-me");
  });

  it("en seguro, Gemini solo aprueba ediciones", () => {
    expect(withAutonomy("gemini-cli", "gemini", "safe")).toBe("gemini --approval-mode auto_edit");
  });

  it("en seguro, Claude Code solo acepta las ediciones de archivos (no es un bypass)", () => {
    expect(withAutonomy("claude-code", "claude", "safe")).toBe("claude --permission-mode acceptEdits");
    expect(withAutonomy("claude-code", "claude --permission-mode manual", "safe")).toBe("claude --permission-mode manual");
  });

  it("Antigravity no recibe flag de permisos acá: ya lo trae del catálogo y no se pisan", () => {
    expect(withAutonomy("antigravity", "agy", "safe")).toBe("agy");
  });

  it("nunca agrega un modo peligroso", () => {
    for (const id of ["codex", "antigravity", "gemini-cli", "claude-code"]) {
      const out = withAutonomy(id, id, "safe");
      expect(out).not.toMatch(/dangerously|yolo|bypass|skip-permissions/);
    }
  });

  it("en preguntar y en agentes sin flag, el comando queda igual", () => {
    expect(withAutonomy("codex", "codex", "ask")).toBe("codex");
    expect(withAutonomy("claude-code", "claude", "ask")).toBe("claude");
    expect(withAutonomy("opencode", "opencode", "safe")).toBe("opencode");
  });

  it("no repite un flag que el comando ya trae", () => {
    expect(withAutonomy("codex", "codex --approve-for-me", "safe")).toBe("codex --approve-for-me");
  });

  it("sin almacenamiento usa el valor por defecto", () => {
    expect(getAutonomy()).toBe(DEFAULT_AUTONOMY);
  });
});
