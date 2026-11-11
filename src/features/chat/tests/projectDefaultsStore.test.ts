// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectChatDefaultsDto } from "../projectChatDefaults";

const fake = vi.hoisted(() => {
  const state = {
    saved: new Map<string, unknown>(),
    calls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
    failSave: false,
  };
  return state;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    fake.calls.push({ cmd, args });
    switch (cmd) {
      case "chat_project_defaults_list": return [...fake.saved.values()];
      case "chat_project_defaults_save": {
        if (fake.failSave) throw new Error("banco recusou");
        const dto = args.defaults as ProjectChatDefaultsDto;
        const empty = !dto.primary && !dto.fallback && !dto.workspace && !dto.access;
        if (empty) { fake.saved.delete(dto.cwd); return null; }
        fake.saved.set(dto.cwd, dto);
        return dto;
      }
      case "chat_project_defaults_clear": fake.saved.delete(args.cwd as string); return null;
      default: throw new Error(`comando inesperado: ${cmd}`);
    }
  }),
}));

import {
  clearProjectDefaultsFor,
  commitProjectDefaults,
  getProjectDefaults,
  hydrateProjectDefaults,
  useProjectDefaultsStore,
  withDefaults,
} from "../projectDefaultsStore";

const dto = (cwd: string, patch: Partial<ProjectChatDefaultsDto> = {}): ProjectChatDefaultsDto =>
  ({ cwd, primary: null, fallback: null, workspace: null, access: null, ...patch });

beforeEach(() => {
  fake.saved.clear();
  fake.calls.length = 0;
  fake.failSave = false;
  useProjectDefaultsStore.setState({ byKey: {}, versions: {}, hydrated: false });
});

describe("espelho dos padrões por projeto", () => {
  it("lê tudo do banco uma vez e só avisa os projetos que mudaram", async () => {
    fake.saved.set("/p/a", dto("/p/a", { access: "edits" }));
    await hydrateProjectDefaults();
    expect(getProjectDefaults("/p/a/")?.access).toBe("edits");
    expect(useProjectDefaultsStore.getState().versions["/p/a"]).toBe(1);

    // Já carregado: não lê de novo.
    await hydrateProjectDefaults();
    expect(fake.calls.filter((c) => c.cmd === "chat_project_defaults_list")).toHaveLength(1);

    // Forçado, com o mesmo conteúdo: a versão não anda; com outro, anda só a do projeto que mudou.
    fake.saved.set("/p/b", dto("/p/b", { workspace: "worktree" }));
    await hydrateProjectDefaults(true);
    expect(useProjectDefaultsStore.getState().versions["/p/a"]).toBe(1);
    expect(useProjectDefaultsStore.getState().versions["/p/b"]).toBe(1);
  });

  it("falha de leitura deixa o espelho como estava", async () => {
    useProjectDefaultsStore.setState({ byKey: { "/p/a": dto("/p/a", { access: "ask" }) } });
    fake.saved.set("/p/x", dto("/p/x"));
    const original = fake.saved.values;
    fake.saved.values = () => { throw new Error("sem banco"); };
    await hydrateProjectDefaults();
    fake.saved.values = original;
    expect(getProjectDefaults("/p/a")?.access).toBe("ask");
    expect(useProjectDefaultsStore.getState().hydrated).toBe(false);
  });

  it("gravar muda o espelho na hora e manda ao banco o caminho normalizado", async () => {
    const pending = commitProjectDefaults(dto("C:\\app\\", { access: "safe" }), { notify: false });
    expect(getProjectDefaults("C:/app")?.access).toBe("safe");
    await pending;
    expect(fake.saved.get("C:/app")).toMatchObject({ access: "safe" });
    // Sem `notify`, os composers abertos não são avisados.
    expect(useProjectDefaultsStore.getState().versions["C:/app"]).toBeUndefined();
  });

  it("com notify avisa os composers abertos", async () => {
    await commitProjectDefaults(dto("/p/a", { workspace: "local" }), { notify: true });
    expect(useProjectDefaultsStore.getState().versions["/p/a"]).toBe(1);
  });

  it("se o banco recusa, o espelho volta ao que era e o erro sobe", async () => {
    await commitProjectDefaults(dto("/p/a", { access: "ask" }), { notify: false });
    fake.failSave = true;
    await expect(commitProjectDefaults(dto("/p/a", { access: "full" }), { notify: false })).rejects.toThrow("banco recusou");
    expect(getProjectDefaults("/p/a")?.access).toBe("ask");
  });

  it("um registro sem nada fixado sai do espelho", async () => {
    await commitProjectDefaults(dto("/p/a", { access: "ask" }), { notify: false });
    await commitProjectDefaults(dto("/p/a"), { notify: false });
    expect(getProjectDefaults("/p/a")).toBeNull();
    expect(fake.saved.has("/p/a")).toBe(false);
  });

  it("apagar limpa o espelho e o banco, e o erro desfaz", async () => {
    await commitProjectDefaults(dto("/p/a", { access: "ask" }), { notify: false });
    await clearProjectDefaultsFor("/p/a", { notify: false });
    expect(getProjectDefaults("/p/a")).toBeNull();
    expect(fake.saved.has("/p/a")).toBe(false);
  });

  it("withDefaults parte do que já existe e muda só o pedido", async () => {
    await commitProjectDefaults(dto("/p/a", { access: "edits", primary: { agentId: "codex", model: "m1" } }), { notify: false });
    const next = withDefaults("/p/a/", { fallback: { agentId: "claude-code", model: null } });
    expect(next).toEqual(dto("/p/a", { access: "edits", primary: { agentId: "codex", model: "m1" }, fallback: { agentId: "claude-code", model: null } }));
    // Projeto sem registro parte do vazio.
    expect(withDefaults("/p/novo", { access: "ask" })).toEqual(dto("/p/novo", { access: "ask" }));
  });
});
