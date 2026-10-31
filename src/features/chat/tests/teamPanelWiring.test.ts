import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

describe("trocar de conversa não mexe na aba do painel direito", () => {
  const shell = read("../ChatShell.tsx");

  it("nada reabre o painel Time ao ligar uma conversa de um time (o gancho por conversa saiu)", () => {
    expect(shell).not.toContain("useOpenTeamPanel");
    expect(read("../team/TeamSidebar.tsx")).not.toContain("useOpenTeamPanel");
  });

  it("entrar numa conversa nova tira o Time do painel (só com o rascunho vazio)", () => {
    expect(shell).toMatch(/panelForNewConversation\(/);
  });
});
