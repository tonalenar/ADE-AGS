import { beforeEach, describe, expect, it, vi } from "vitest";

// A tela do terminal é lida pelo registro; o teste controla o que ela mostra no momento do clique.
const term = vi.hoisted(() => ({ lines: [] as string[], sendKeysToTab: vi.fn(() => true) }));
vi.mock("@/features/terminal/terminalRegistry", () => ({
  screenOf: () => ({ lines: term.lines }),
  sendKeysToTab: term.sendKeysToTab,
}));

import { promptDaTela } from "../terminalPrompts";
import { answerTerminalPrompt } from "../useTerminalPrompts";

const CLAUDE = [
  "⏺ Bash(npm test)",
  "  ⎿  Running…",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
];

beforeEach(() => {
  vi.clearAllMocks();
  term.sendKeysToTab.mockReturnValue(true);
});

describe("answerTerminalPrompt: releitura da tela no clique", () => {
  it("tecla_so_vai_ao_pty_se_o_mesmo_menu_ainda_esta_na_tela", () => {
    term.lines = CLAUDE;
    const prompt = promptDaTela(CLAUDE);
    expect(prompt).not.toBeNull();
    const allow = prompt!.choices[0]!;

    // O menu sumiu (foi respondido no terminal, ou o agente imprimiu outra coisa): nada é enviado.
    term.lines = ["$ ls", "README.md"];
    expect(answerTerminalPrompt("t1", allow, prompt!.signature)).toBe(false);
    expect(term.sendKeysToTab).not.toHaveBeenCalled();

    // Mesmo menu, mesma assinatura: a tecla segue.
    term.lines = CLAUDE;
    expect(answerTerminalPrompt("t1", allow, prompt!.signature)).toBe(true);
    expect(term.sendKeysToTab).toHaveBeenCalledWith("t1", "1");
  });

  it("menu trocado por outro com a mesma opção não recebe a tecla", () => {
    term.lines = CLAUDE;
    const prompt = promptDaTela(CLAUDE)!;
    term.lines = CLAUDE.map((l) => l.replace("Do you want to proceed?", "Do you want to run rm -rf?"));
    expect(answerTerminalPrompt("t1", prompt.choices[0]!, prompt.signature)).toBe(false);
    expect(term.sendKeysToTab).not.toHaveBeenCalled();
  });
});
