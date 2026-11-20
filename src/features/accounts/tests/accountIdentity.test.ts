import { describe, expect, it } from "vitest";

import {
  ACCOUNT_COLORS, accountBadgeStyle, accountDisplayLabel, accountInitials, isAccountColorToken,
  shouldShowAccountBadge,
} from "@/features/accounts/accountIdentity";
import type { AgentAccount } from "@/features/accounts/types";

function conta(over: Partial<AgentAccount>): AgentAccount {
  return {
    id: "a", agentId: "claude-code", name: "trabalho", dir: "/d", envVar: "CLAUDE_CONFIG_DIR",
    loginCommand: "claude", loggedIn: true, label: null, createdAt: 1, kind: "login", baseUrl: null,
    keyHint: null, displayName: null, accentColor: null, ...over,
  };
}

describe("accountInitials", () => {
  it("usa as duas primeiras letras de uma palavra só", () => {
    expect(accountInitials("Antigravity")).toBe("AN");
    expect(accountInitials("trabalho")).toBe("TR");
  });
  it("usa a inicial das duas primeiras palavras", () => {
    expect(accountInitials("Antigravity 2")).toBe("A2");
    expect(accountInitials("Conta do João")).toBe("CD");
  });
  it("pontuação separa palavras; apóstrofo dentro da palavra fica", () => {
    expect(accountInitials("Codex (hub)")).toBe("CH");
    expect(accountInitials("Theo's Codex")).toBe("TC");
    expect(accountInitials("conta-2")).toBe("C2");
    expect(accountInitials("conta_pessoal")).toBe("CP");
  });
  it("uma palavra em camel case separa nas corcovas", () => {
    expect(accountInitials("ClaudeProx")).toBe("CP");
    expect(accountInitials("ClaudeProx Work")).toBe("CW");
  });
  it("vazio e só pontuação não dão iniciais", () => {
    expect(accountInitials("")).toBe("");
    expect(accountInitials("  ...  ")).toBe("");
  });
});

describe("paleta de cores da conta", () => {
  it("tem 8 matizes distintos, só por token do tema, sem hex", () => {
    expect(ACCOUNT_COLORS).toHaveLength(8);
    expect(new Set(ACCOUNT_COLORS.map((c) => c.token)).size).toBe(8);
    for (const c of ACCOUNT_COLORS) {
      expect(c.background).toMatch(/^var\(--color-[a-z]+-\d+\)$/);
      expect(c.foreground).toMatch(/^var\(--color-gray-\d+\)$/);
      expect(`${c.background}${c.foreground}`).not.toMatch(/#|rgb|oklch/);
    }
  });
  it("reconhece só o nome de um token da paleta", () => {
    expect(isAccountColorToken("green")).toBe(true);
    for (const ruim of ["#ff0000", "RED", "", null, undefined, 3, "var(--color-red-500)"]) {
      expect(isAccountColorToken(ruim)).toBe(false);
    }
  });
  it("accountBadgeStyle devolve o token resolvido, ou nada sem cor ou com cor desconhecida", () => {
    expect(accountBadgeStyle("orange")).toEqual({
      backgroundColor: expect.stringContaining("--color-orange-"),
      color: expect.stringContaining("--color-gray-"),
    });
    expect(accountBadgeStyle(null)).toBeUndefined();
    expect(accountBadgeStyle("chartreuse")).toBeUndefined();
  });
});

describe("accountDisplayLabel", () => {
  it("prefere o nome de exibição", () => {
    expect(accountDisplayLabel(conta({ displayName: "Pessoal" }), "Principal")).toBe("Pessoal");
  });
  it("a conta principal sem nome vira o rótulo padrão", () => {
    expect(accountDisplayLabel(conta({ id: "system:claude-code", name: "Claude Code" }), "Principal")).toBe("Principal");
  });
  it("conta comum sem nome de exibição usa o nome da pasta", () => {
    expect(accountDisplayLabel(conta({}), "Principal")).toBe("trabalho");
  });
  it("nome de exibição só com espaços é ignorado", () => {
    expect(accountDisplayLabel(conta({ displayName: "   " }), "Principal")).toBe("trabalho");
  });
});

describe("shouldShowAccountBadge", () => {
  const a = conta({ id: "a" });
  const b = conta({ id: "b", name: "pessoal" });
  const outro = conta({ id: "c", agentId: "codex" });
  it("não mostra com uma conta só e sem cor", () => {
    expect(shouldShowAccountBadge(a, [a, outro])).toBe(false);
  });
  it("mostra quando há mais de uma conta do mesmo agente", () => {
    expect(shouldShowAccountBadge(a, [a, b])).toBe(true);
  });
  it("mostra quando a conta tem cor, mesmo sozinha", () => {
    const colorida = conta({ accentColor: "green" });
    expect(shouldShowAccountBadge(colorida, [colorida])).toBe(true);
  });
  it("uma cor desconhecida não conta como cor", () => {
    const lixo = conta({ accentColor: "#fff" });
    expect(shouldShowAccountBadge(lixo, [lixo])).toBe(false);
  });
});
