import { describe, expect, it } from "vitest";
import { detectPermissionPrompt } from "../terminalPrompts";

const ESC = "\u001b";

const CODEX_CMD = [
  "$ git status",
  "",
  "  Would you like to run the following command?",
  "",
  "  Reason: precisa verificar o estado do repositório",
  "  Environment: local",
  "",
  "  $ git status --short",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `git status` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
];

const CODEX_MCP = [
  "Field 1/1",
  'Allow Supabase to run tool "supabase.execute_sql"?',
  "project_id: abc123",
  "query: select count(*) from users",
  "",
  "› 1. Allow   Run the tool and continue",
  "  2. Allow for this session",
  "  3. Always allow",
  "  4. Cancel   Cancel this tool call",
  "",
  "enter to submit | esc to cancel",
];

const CLAUDE_CMD = [
  "⏺ Bash(npm test)",
  "  ⎿  Running…",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No, and tell Claude what to do differently (esc)",
];

const CLAUDE_EDIT = [
  " Do you want to make this edit to src/app.ts?",
  "   1. Yes",
  "   2. Yes, and don't ask again this session",
  "   3. No, and tell Claude what to do differently (esc)",
];

const GEMINI = [
  "Allow execution of 'rm -rf dist'?",
  "● 1. Allow once",
  "  2. Allow for this session",
  "  3. No, suggest changes (esc)",
];

describe("detectPermissionPrompt", () => {
  it("Codex: comando com opção 'don't ask again'", () => {
    const p = detectPermissionPrompt(CODEX_CMD);
    expect(p).not.toBeNull();
    expect(p?.kind).toBe("command");
    expect(p?.title).toBe("Would you like to run the following command?");
    expect(p?.detail).toContain("Environment: local");
    expect(p?.detail).toContain("$ git status --short");
    const byId = Object.fromEntries((p?.choices ?? []).map((c) => [c.id, c.keys]));
    expect(byId).toEqual({ allow: "1", allowSession: "2", deny: ESC });
  });

  it("Codex: MCP com Allow / Allow for this session / Cancel", () => {
    const p = detectPermissionPrompt(CODEX_MCP);
    expect(p?.kind).toBe("tool");
    expect(p?.title).toBe('Allow Supabase to run tool "supabase.execute_sql"?');
    expect(p?.detail).toBe(
      "project_id: abc123\nquery: select count(*) from users",
    );
    const byId = Object.fromEntries((p?.choices ?? []).map((c) => [c.id, c.keys]));
    expect(byId).toEqual({ allow: "1", allowSession: "2", deny: ESC });
  });

  it("Claude Code: proceed com opção de sessão", () => {
    const p = detectPermissionPrompt(CLAUDE_CMD);
    expect(p?.title).toBe("Do you want to proceed?");
    const byId = Object.fromEntries((p?.choices ?? []).map((c) => [c.id, c.keys]));
    expect(byId).toEqual({ allow: "1", allowSession: "2", deny: ESC });
  });

  it("Claude Code: edição sem a opção 'session' ainda acha a opção de sessão", () => {
    const p = detectPermissionPrompt(CLAUDE_EDIT);
    expect(p?.kind).toBe("edit");
    expect(p?.title).toBe("Do you want to make this edit to src/app.ts?");
    const session = p?.choices.find((c) => c.id === "allowSession");
    expect(session?.keys).toBe("2");
  });

  it("Gemini/Antigravity: Allow execution com marcador ●", () => {
    const p = detectPermissionPrompt(GEMINI);
    expect(p?.kind).toBe("execution");
    expect(p?.title).toBe("Allow execution of 'rm -rf dist'?");
    const byId = Object.fromEntries((p?.choices ?? []).map((c) => [c.id, c.keys]));
    expect(byId).toEqual({ allow: "1", allowSession: "2", deny: ESC });
  });

  it("prompt antigo no scrollback, com texto novo abaixo, não conta", () => {
    const screen = [
      ...CODEX_CMD,
      "Yes, proceed",
      "saída do comando",
      "linha 1",
      "linha 2",
      "linha 3",
      "linha 4",
      "linha 5",
      "linha 6",
      "linha 7",
      "linha 8",
    ];
    expect(detectPermissionPrompt(screen)).toBeNull();
  });

  it("prompt mais antigo que a janela das últimas 25 linhas não conta", () => {
    const screen = [...CODEX_CMD, ...Array.from({ length: 20 }, (_, i) => `saída ${i}`), "enter to submit"];
    expect(detectPermissionPrompt(screen)).toBeNull();
  });

  it("tela sem prompt = null", () => {
    expect(detectPermissionPrompt(["$ npm run build", "built in 1.2s", "$"])).toBeNull();
    expect(detectPermissionPrompt([])).toBeNull();
    expect(detectPermissionPrompt(null)).toBeNull();
  });

  it("lista numerada que não é de permissão = null", () => {
    expect(
      detectPermissionPrompt(["Passos:", "1. Instalar dependências", "2. Rodar testes"]),
    ).toBeNull();
  });

  it("signature é estável para a mesma tela e muda com outro comando", () => {
    const a = detectPermissionPrompt(CODEX_CMD);
    const b = detectPermissionPrompt([...CODEX_CMD]);
    const other = detectPermissionPrompt(
      CODEX_CMD.map((l) => l.replace("git status --short", "git push")),
    );
    expect(a?.signature).toBeTruthy();
    expect(a?.signature).toBe(b?.signature);
    expect(other?.signature).not.toBe(a?.signature);
  });

  it("detail é limitado a 400 caracteres e 6 linhas", () => {
    const long = "x".repeat(300);
    const screen = [
      "Would you like to run the following command?",
      ...Array.from({ length: 8 }, (_, i) => `linha ${i} ${long}`),
      "1. Yes, proceed (y)",
      "2. No (esc)",
    ];
    const p = detectPermissionPrompt(screen);
    expect(p).not.toBeNull();
    expect(p?.detail.length).toBeLessThanOrEqual(400);
    expect(p?.detail.split("\n").length).toBeLessThanOrEqual(6);
  });
});
