/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const i18nResult = { t: (k: string) => k };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

const fake = vi.hoisted(() => ({ saved: new Map<string, Record<string, unknown>>(), confirm: true }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "chat_project_defaults_save") {
      const dto = args.defaults as { cwd: string; primary: unknown; fallback: unknown; workspace: unknown; access: unknown };
      if (dto.fallback && dto.primary && JSON.stringify(dto.fallback) === JSON.stringify(dto.primary)) {
        throw new Error("O modelo reserva precisa ser diferente do principal");
      }
      fake.saved.set(dto.cwd, dto);
      return dto;
    }
    throw new Error(`comando inesperado: ${cmd}`);
  }),
}));

vi.mock("@/features/agents/useAvailableAgents", () => ({
  useAvailableAgents: () => [
    { id: "codex", label: "Codex" },
    { id: "claude-code", label: "Claude Code" },
    { id: "bash", label: "Shell" },
  ],
}));

vi.mock("@/shared/ui/appConfirm", () => ({ appConfirm: vi.fn(async () => fake.confirm) }));

import { loadChatProjectDefaults } from "@/features/chat/chatProjectPrefs";
import { useProjectDefaultsStore } from "@/features/chat/projectDefaultsStore";
import { appConfirm } from "@/shared/ui/appConfirm";
import { ProjectDefaultsSetting } from "../ProjectDefaultsSettings";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.clear();
  fake.saved.clear();
  fake.confirm = true;
  vi.mocked(appConfirm).mockClear();
  useProjectDefaultsStore.setState({ byKey: {}, versions: {}, hydrated: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<ProjectDefaultsSetting cwd="/p/app" />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const select = (label: string) =>
  [...container.querySelectorAll("select")].find((el) => el.getAttribute("aria-label") === label) as HTMLSelectElement;
const pick = (label: string, value: string) => act(async () => {
  const el = select(label);
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
/** Os botões do seletor de workspace (`group` com `aria-pressed`). O seletor de agente também tem um botão com o texto «herdar». */
const workspaceButton = (text: string) =>
  [...container.querySelectorAll("[role=group] button")].find((b) => b.textContent === text) as HTMLButtonElement;

describe("Projetos: padrões das conversas novas", () => {
  it("escolher o agente grava o par (sem modelo) para o composer e para o banco", async () => {
    await pick("settings.projects.defaults.primary", "codex");
    expect(loadChatProjectDefaults("/p/app")).toMatchObject({ agentId: "codex", model: null });
    expect(fake.saved.get("/p/app")).toMatchObject({ primary: { agentId: "codex", model: null } });
  });

  it("digitar o modelo grava junto com o agente, e voltar a herdar apaga os dois", async () => {
    await pick("settings.projects.defaults.primary", "codex");
    const input = container.querySelector("input[aria-label=\"settings.projects.defaults.model\"]") as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gpt-6.1-sol");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(fake.saved.get("/p/app")).toMatchObject({ primary: { agentId: "codex", model: "gpt-6.1-sol" } });

    await pick("settings.projects.defaults.primary", "");
    expect(loadChatProjectDefaults("/p/app")?.agentId).toBeUndefined();
    expect(fake.saved.get("/p/app")).toMatchObject({ primary: null });
  });

  it("o modelo reserva vai só ao banco e não pode ser igual ao principal", async () => {
    await pick("settings.projects.defaults.primary", "codex");
    await pick("settings.projects.defaults.fallback", "claude-code");
    expect(fake.saved.get("/p/app")).toMatchObject({ fallback: { agentId: "claude-code", model: null }, primary: { agentId: "codex" } });
    // O composer não tem campo de reserva: o aparelho só conhece o principal.
    expect(loadChatProjectDefaults("/p/app")).not.toHaveProperty("fallback");

    // Reserva igual ao principal: o banco recusa e a tela mostra o erro, sem trocar o que estava.
    await pick("settings.projects.defaults.fallback", "codex");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("diferente do principal");
    expect(fake.saved.get("/p/app")).toMatchObject({ fallback: { agentId: "claude-code" } });
  });

  it("o workspace padrão grava local ou worktree, e herdar apaga", async () => {
    await act(async () => workspaceButton("chat.workspace.newWorktree").click());
    expect(loadChatProjectDefaults("/p/app")?.worktree).toBe(true);
    expect(fake.saved.get("/p/app")).toMatchObject({ workspace: "worktree" });
    await act(async () => workspaceButton("chat.new.currentCheckout").click());
    expect(fake.saved.get("/p/app")).toMatchObject({ workspace: "local" });
    await act(async () => workspaceButton("settings.projects.defaults.inherit").click());
    expect(loadChatProjectDefaults("/p/app")?.worktree).toBeUndefined();
  });

  it("a permissão grava, e acesso total só vale depois da confirmação", async () => {
    await pick("settings.projects.defaults.access", "edits");
    expect(fake.saved.get("/p/app")).toMatchObject({ access: "edits" });
    expect(appConfirm).not.toHaveBeenCalled();

    fake.confirm = false;
    await pick("settings.projects.defaults.access", "full");
    expect(appConfirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appConfirm).mock.calls[0]![0]).toMatchObject({ tone: "danger" });
    expect(loadChatProjectDefaults("/p/app")?.access).toBe("edits");

    fake.confirm = true;
    await pick("settings.projects.defaults.access", "full");
    expect(loadChatProjectDefaults("/p/app")?.access).toBe("full");
    expect(fake.saved.get("/p/app")).toMatchObject({ access: "full" });
  });

  it("avisa o composer aberto quando o projeto muda por aqui", async () => {
    const before = useProjectDefaultsStore.getState().versions["/p/app"] ?? 0;
    await pick("settings.projects.defaults.access", "ask");
    expect(useProjectDefaultsStore.getState().versions["/p/app"]).toBeGreaterThan(before);
  });
});
