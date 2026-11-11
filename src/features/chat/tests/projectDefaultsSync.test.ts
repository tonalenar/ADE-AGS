// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectChatDefaultsDto } from "../projectChatDefaults";

const fake = vi.hoisted(() => ({ saved: new Map<string, unknown>(), saves: [] as unknown[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "chat_project_defaults_list") return [...fake.saved.values()];
    if (cmd === "chat_project_defaults_save") {
      const dto = args.defaults as ProjectChatDefaultsDto;
      fake.saves.push(dto);
      const empty = !dto.primary && !dto.fallback && !dto.workspace && !dto.access;
      if (empty) { fake.saved.delete(dto.cwd); return null; }
      fake.saved.set(dto.cwd, dto);
      return dto;
    }
    throw new Error(`comando inesperado: ${cmd}`);
  }),
}));

import {
  clearChatProjectDefaults,
  inheritChatProjectField,
  loadChatProjectDefaults,
  saveChatProjectDefaults,
  saveChatProjectField,
  saveChatProjectFields,
} from "../chatProjectPrefs";
import { DEFAULT_CHAT_PREFS } from "../chatPrefs";
import { commitProjectDefaults, getProjectDefaults, useProjectDefaultsStore } from "../projectDefaultsStore";
import { syncProjectDefaults } from "../projectDefaultsSync";

const dto = (cwd: string, patch: Partial<ProjectChatDefaultsDto> = {}): ProjectChatDefaultsDto =>
  ({ cwd, primary: null, fallback: null, workspace: null, access: null, ...patch });

/** Deixa as promessas encadeadas da gravação (microtarefas) terminarem, sem esperar relógio. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
  fake.saved.clear();
  fake.saves.length = 0;
  useProjectDefaultsStore.setState({ byKey: {}, versions: {}, hydrated: false });
});

afterEach(() => localStorage.clear());

describe("os padrões do composer vão também para o banco", () => {
  it("fixar a permissão num campo grava no aparelho e no banco", async () => {
    expect(saveChatProjectField("/p/app", "access", "edits")).toBe(true);
    await settle();
    expect(loadChatProjectDefaults("/p/app")?.access).toBe("edits");
    expect(fake.saved.get("/p/app")).toMatchObject({ access: "edits", primary: null, workspace: null });
  });

  it("o modelo só vai ao banco junto com o agente, e o par grava de uma vez", async () => {
    saveChatProjectField("/p/app", "model", "gpt-6");
    await settle();
    expect(fake.saved.get("/p/app")).toBeUndefined();

    saveChatProjectFields("/p/app", { agentId: "codex", model: "gpt-6" });
    await settle();
    expect(fake.saved.get("/p/app")).toMatchObject({ primary: { agentId: "codex", model: "gpt-6" } });
    expect(fake.saves).toHaveLength(1);
  });

  it("o workspace padrão vira local ou worktree", async () => {
    saveChatProjectField("/p/app", "worktree", true);
    await settle();
    expect(fake.saved.get("/p/app")).toMatchObject({ workspace: "worktree" });
    saveChatProjectField("/p/app", "worktree", false);
    await settle();
    expect(fake.saved.get("/p/app")).toMatchObject({ workspace: "local" });
  });

  it("herdar um campo o tira do banco, e o registro vazio some", async () => {
    saveChatProjectField("/p/app", "access", "full");
    await settle();
    inheritChatProjectField("/p/app", "access");
    await settle();
    expect(loadChatProjectDefaults("/p/app")?.access).toBeUndefined();
    expect(fake.saved.has("/p/app")).toBe(false);
  });

  it("o composer não apaga o modelo reserva, que ele não edita", async () => {
    await commitProjectDefaults(dto("/p/app", { fallback: { agentId: "claude-code", model: "opus" } }), { notify: false });
    saveChatProjectField("/p/app", "access", "safe");
    await settle();
    expect(fake.saved.get("/p/app")).toMatchObject({ access: "safe", fallback: { agentId: "claude-code", model: "opus" } });
    // Nem ao limpar os padrões do composer.
    clearChatProjectDefaults("/p/app");
    await settle();
    expect(fake.saved.get("/p/app")).toMatchObject({ access: null, fallback: { agentId: "claude-code", model: "opus" } });
  });

  it("o snapshot completo do composer vira o par, a permissão e o workspace", async () => {
    saveChatProjectDefaults("/p/app", { ...DEFAULT_CHAT_PREFS, agentId: "codex", model: "m1", access: "ask", worktree: true });
    await settle();
    expect(fake.saved.get("/p/app")).toMatchObject({ primary: { agentId: "codex", model: "m1" }, access: "ask", workspace: "worktree" });
  });

  it("um valor inválido não grava nada, nem no aparelho nem no banco", async () => {
    expect(saveChatProjectFields("/p/app", { access: "tudo" as never })).toBe(false);
    await settle();
    expect(loadChatProjectDefaults("/p/app")).toBeNull();
    expect(fake.saves).toHaveLength(0);
  });
});

describe("conciliar o aparelho com o banco", () => {
  it("o que o banco tem e o aparelho não entra no aparelho e avisa o composer", async () => {
    fake.saved.set("/p/app", dto("/p/app", { primary: { agentId: "codex", model: "m1" }, access: "edits", workspace: "worktree" }));
    await syncProjectDefaults();
    expect(loadChatProjectDefaults("/p/app")).toMatchObject({ agentId: "codex", model: "m1", access: "edits", worktree: true });
    expect(useProjectDefaultsStore.getState().versions["/p/app"]).toBeGreaterThan(0);
  });

  it("o que o aparelho tem e o banco não vai para o banco (padrões de antes do banco)", async () => {
    localStorage.setItem("cc-chat-project-defaults", JSON.stringify({ "/p/velho": { agentId: "claude-code", model: null, access: "safe", worktree: false } }));
    await syncProjectDefaults();
    expect(fake.saved.get("/p/velho")).toMatchObject({ primary: { agentId: "claude-code", model: null }, access: "safe", workspace: "local" });
  });

  it("quando os dois têm o campo, vale o do aparelho", async () => {
    saveChatProjectField("/p/app", "access", "ask");
    await settle();
    fake.saved.set("/p/app", dto("/p/app", { access: "full" }));
    await syncProjectDefaults();
    expect(loadChatProjectDefaults("/p/app")?.access).toBe("ask");
    expect(fake.saved.get("/p/app")).toMatchObject({ access: "ask" });
  });

  it("um campo que a pessoa mandou herdar não volta do banco", async () => {
    // Legado com permissão fixada; a pessoa mandou herdar (o marcador esconde o legado).
    localStorage.setItem("cc-chat-project-defaults", JSON.stringify({ "/p/app": { access: "full" } }));
    inheritChatProjectField("/p/app", "access");
    await settle();
    fake.saved.set("/p/app", dto("/p/app", { access: "full", workspace: "worktree" }));
    await syncProjectDefaults();
    expect(loadChatProjectDefaults("/p/app")?.access).toBeUndefined();
    expect(loadChatProjectDefaults("/p/app")?.worktree).toBe(true);
    expect(getProjectDefaults("/p/app")?.access).toBeNull();
  });

  it("sem nada de nenhum lado não grava nada", async () => {
    await syncProjectDefaults();
    expect(fake.saves).toHaveLength(0);
  });
});
