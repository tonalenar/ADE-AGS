// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => ({ calls: [] as unknown[][], result: { ok: true, ref: "tab-1", teamId: "t1" } as unknown, submitted: [] as boolean[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && "agent" in o ? `${key}:${o.agent}` : o && "error" in o ? `${key}:${o.error}` : o && "items" in o ? `${key}:${o.items}` : key), i18n: { language: "pt-BR" } }),
}));
vi.mock("@/features/agents/useAvailableAgents", () => ({
  useAvailableAgents: () => [
    { id: "claude-code", label: "Claude Code", command: "claude", available: true },
    { id: "codex", label: "Codex", command: "codex", available: true },
  ],
}));
vi.mock("../AgentModelPicker", () => ({ AgentModelPicker: () => null, EffortMenu: () => null, hasEffort: () => false }));
vi.mock("../AccessMenu", () => ({ AccessMenu: () => null }));
vi.mock("../ComposerColumn", () => ({ useColumnGutter: () => ({ ref: () => undefined, style: {} }) }));
// O composer de verdade tem editor, anexos e menus: aqui só importa o que a tela passa a ele e o que ele devolve.
vi.mock("../ChatComposer", () => ({
  ChatComposer: (p: { controls: React.ReactNode; placeholder: string; onSubmit: (text: string) => Promise<boolean> }) => (
    <div>
      <div data-testid="controls">{p.controls}</div>
      <div data-testid="placeholder">{p.placeholder}</div>
      <button type="button" data-testid="send" onClick={async () => { launch.submitted.push(await p.onSubmit("monte o painel")); }} />
    </div>
  ),
}));
vi.mock("../team/teamLaunch", () => ({ launchDraftTeam: (...args: unknown[]) => { launch.calls.push(args); return Promise.resolve(launch.result); } }));

import { NewConversation } from "../NewConversation";
import { addToDraft, clearDraft, useTeamDraft } from "../team/draftStore";
import type { DraftMember } from "../team/teamDraft";
import { useTeamStore } from "../team/teamStore";
import { useChatStore } from "../store";

const codex: DraftMember = {
  id: "d1", kind: "new", agent: { id: "codex", label: "Codex", command: "codex", available: true } as never, role: "reviewer", policy: "read", subagent: false, model: null, effort: null, worktree: true,
};
const PROJECTS = [{ cwd: "/p/ADE-AGS", name: "ADE-AGS", branch: "main" }, { cwd: "/p/Outro", name: "Outro", branch: null }];

let root: Root;
let host: HTMLDivElement;
const mount = (folder: string | null = null) => act(async () => { root.render(<NewConversation projects={PROJECTS} folder={folder} onFolder={() => undefined} />); });
const send = () => act(async () => { (host.querySelector("[data-testid=send]") as HTMLElement).click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  launch.calls = []; launch.submitted = []; launch.result = { ok: true, ref: "tab-1", teamId: "t1" };
  clearDraft();
  useTeamStore.setState({ teams: [], targets: {} });
  useChatStore.setState({ composing: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearDraft(); });

describe('a tela "Nova conversa" já no projeto escolhido pelo "+"', () => {
  it("a pergunta traz o projeto pedido, não o primeiro da lista", async () => {
    await mount("/p/Outro");
    expect(host.querySelector("h1")?.textContent).toContain("Outro");
    expect(host.querySelector("h1")?.textContent).not.toContain("ADE-AGS");
  });

  it("sem pedido, cai no primeiro projeto", async () => {
    await mount(null);
    expect(host.querySelector("h1")?.textContent).toContain("ADE-AGS");
  });
});

describe("o time montado antes da conversa", () => {
  it("o painel Time recebe como orquestrador o agente do composer e a pasta do projeto", async () => {
    await mount("/p/Outro");
    expect(useTeamDraft.getState().lead).toEqual({ agentId: "claude-code", label: "Claude Code", cwd: "/p/Outro" });
  });

  it("sem integrante no rascunho, nada muda: sem seletor 'Time | Só o orquestrador' e o envio é o de sempre", async () => {
    await mount("/p/Outro");
    expect(host.querySelector("[aria-label='chat.team.target.label']")).toBeNull();
    expect(host.querySelector("[data-testid=placeholder]")?.textContent).toBe("chat.composer.placeholder");
    await send();
    expect(launch.calls).toEqual([]);
  });

  it("com integrante no rascunho o composer ganha o seletor e o placeholder do time", async () => {
    await mount("/p/Outro");
    await act(async () => { addToDraft(codex); });
    expect(host.querySelector("[aria-label='chat.team.target.label']")).not.toBeNull();
    expect(host.querySelector("[data-testid=placeholder]")?.textContent).toBe("chat.team.placeholder:codex");
    await act(async () => { (host.querySelectorAll("[aria-label='chat.team.target.label'] button")[1] as HTMLElement).click(); });
    expect(host.querySelector("[data-testid=placeholder]")?.textContent).toBe("chat.team.placeholderLead");
  });

  it("enviar cria a conversa COM o time: orquestrador do composer, integrantes, texto e destino", async () => {
    await mount("/p/Outro");
    await act(async () => { addToDraft(codex); });
    await send();
    expect(launch.calls).toHaveLength(1);
    const [spec, members, prompt, target] = launch.calls[0] as [Record<string, unknown>, DraftMember[], string, string];
    // Por padrão as conversas novas do chat saem por protocolo (sem TUI).
    expect(spec).toMatchObject({ cwd: "/p/Outro", viaProtocol: true });
    expect((spec.agent as { id: string }).id).toBe("claude-code");
    expect(members.map((m) => m.id)).toEqual(["d1"]);
    expect(prompt).toBe("monte o painel");
    expect(target).toBe("team");
    expect(launch.submitted).toEqual([true]);
    expect(useTeamDraft.getState().members).toEqual([]);
  });

  it("em falha mostra o erro, devolve false (o texto fica na caixa) e mantém o rascunho para tentar de novo", async () => {
    launch.result = { ok: false, error: "sem espaço", leftovers: ["worktree team/tests"] };
    await mount("/p/Outro");
    await act(async () => { addToDraft(codex); });
    await send();
    expect(launch.submitted).toEqual([false]);
    const alert = host.querySelector("[role=alert]")?.textContent ?? "";
    expect(alert).toContain("chat.team.draft.failed:sem espaço");
    expect(alert).toContain("chat.team.draft.leftovers:worktree team/tests");
    expect(useTeamDraft.getState().members).toHaveLength(1);
  });

  it("sair da tela descarta o rascunho", async () => {
    await mount("/p/Outro");
    await act(async () => { addToDraft(codex); });
    await act(async () => { root.render(<div />); });
    expect(useTeamDraft.getState().members).toEqual([]);
    expect(useTeamDraft.getState().lead).toBeNull();
  });
});
