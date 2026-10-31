// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ calls: [] as [string, unknown][] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    backend.calls.push([cmd, args]);
    return Promise.resolve([]);
  },
}));
// O seletor de modelo lê o catálogo do backend: aqui só interessa que o formulário o mostra.
vi.mock("../../AgentModelPicker", () => ({
  AgentModelPicker: () => <span data-testid="modelo" />,
  EffortMenu: () => null,
  hasEffort: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && "count" in o ? `${key}:${o.count}` : o && "name" in o ? `${key}:${o.name}` : key), i18n: { language: "pt-BR" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";
import type { ConversationCard } from "../../chatModel";
import { DraftTeamPanel } from "../DraftTeamPanel";
import { clearDraft, setDraftLead, useTeamDraft } from "../draftStore";
import { TeamPanel } from "../TeamPanel";
import { useTeamStore } from "../teamStore";

const agent = (id: string, label: string): AgentInfo => ({ id, label, command: id, available: true } as AgentInfo);
const open: ConversationCard = {
  tabId: "tab-9", title: "Conversa aberta", project: "repo", cwd: "/repo", branch: "main", isWorktree: false, agentId: "gemini", agentLabel: "Gemini", starting: false, active: false, openedAt: 1,
};

let root: Root;
let host: HTMLDivElement;
const mount = (node: React.ReactNode) => act(async () => { root.render(node); });
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const byText = (selector: string, text: string) => [...host.querySelectorAll(selector)].find((e) => e.textContent === text);
// Os itens de agente levam o quadradinho com a inicial antes do nome.
const item = (text: string) => [...host.querySelectorAll("[role=menuitemradio]")].find((e) => e.textContent?.endsWith(text));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  backend.calls = [];
  clearDraft();
  setDraftLead({ agentId: "claude-code", label: "Claude Code", cwd: "/repo" });
  useTeamStore.setState({ teams: [], feeds: {}, targets: {}, told: {}, adding: {} });
  useTabsStore.setState({ detectedAgents: [agent("claude-code", "Claude Code"), agent("codex", "Codex")] } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearDraft(); });

describe("o painel Time sem conversa (rascunho)", () => {
  it("sem conversa aberta, o TeamPanel mostra o rascunho em vez do aviso 'abra uma conversa'", async () => {
    await mount(<TeamPanel conversation={null} cards={[]} />);
    expect(host.textContent).toContain("chat.team.draft.badge");
    expect(host.textContent).not.toContain("chat.team.empty.noConversation");
  });

  it("o orquestrador é o agente do composer e só ele, de início", async () => {
    await mount(<DraftTeamPanel cards={[]} />);
    const items = [...host.querySelectorAll("ul li")];
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Claude Code");
    expect(host.textContent).toContain("chat.team.summary:1");
  });

  it("sem agente escolhido no composer, pede para escolher um", async () => {
    setDraftLead(null);
    await mount(<DraftTeamPanel cards={[]} />);
    expect(host.textContent).toContain("chat.team.draft.noAgent");
  });

  it("'+ Ligar agente' abre o MESMO formulário e liga no rascunho, sem falar com o backend", async () => {
    await mount(<DraftTeamPanel cards={[open]} />);
    await click(byText("button", "chat.team.link"));
    expect(host.querySelector("[role=group]")).not.toBeNull();
    // o agente sugerido é um que o time ainda não tem (Codex), numa conversa nova, no papel Revisor
    await click(byText("button", "chat.team.draft.add"));
    const members = useTeamDraft.getState().members;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ kind: "new", role: "reviewer", policy: "ask", worktree: true });
    expect(members[0]!.kind === "new" && members[0]!.agent.id).toBe("codex");
    expect(host.querySelector("[role=group]")).toBeNull();
    expect(host.querySelectorAll("ul li")).toHaveLength(2);
    expect(host.textContent).toContain("chat.team.summary:2");
    // nada foi criado: nenhum comando do time (a lista inicial de times não conta)
    expect(backend.calls.filter(([cmd]) => cmd.startsWith("chat_team_") && cmd !== "chat_team_list")).toEqual([]);
  });

  it("remove um integrante do rascunho", async () => {
    await mount(<DraftTeamPanel cards={[]} />);
    await click(byText("button", "chat.team.link"));
    await click(byText("button", "chat.team.draft.add"));
    expect(useTeamDraft.getState().members).toHaveLength(1);
    await click(host.querySelector("[aria-label='chat.team.draft.removeAria:Codex']"));
    expect(useTeamDraft.getState().members).toHaveLength(0);
    expect(host.querySelectorAll("ul li")).toHaveLength(1);
  });

  it("edita um integrante com o formulário já preenchido, com o agente travado", async () => {
    await mount(<DraftTeamPanel cards={[]} />);
    await click(byText("button", "chat.team.link"));
    await click(byText("button", "chat.team.draft.add"));
    await click(host.querySelector("[aria-label='chat.team.draft.editAria:Codex']"));
    const form = host.querySelector("[role=group]")!;
    expect(form.getAttribute("aria-label")).toBe("chat.team.draft.editTitle");
    expect(form.querySelector("[aria-label^='chat.team.form.agent']")).toBeNull();
    // troca o papel para "Testes" pelo menu
    await click(form.querySelector("[aria-label^='chat.team.form.role']"));
    await click(byText("[role=menuitemradio]", "chat.team.roles.qa"));
    await click(byText("button", "chat.team.draft.save"));
    expect(useTeamDraft.getState().members[0]).toMatchObject({ role: "qa", kind: "new" });
    expect(host.querySelector("[role=group]")).toBeNull();
  });

  it("uma conversa já aberta também entra no rascunho (e não é oferecida duas vezes)", async () => {
    useTabsStore.setState({ detectedAgents: [agent("claude-code", "Claude Code")] } as never);
    await mount(<DraftTeamPanel cards={[open]} />);
    await click(byText("button", "chat.team.link"));
    // com um só agente (o do orquestrador) a sugestão é ele mesmo; escolhe a conversa aberta no menu
    await click(host.querySelector("[aria-label^='chat.team.form.agent']"));
    await click(item("Conversa aberta"));
    await click(byText("button", "chat.team.draft.add"));
    expect(useTeamDraft.getState().members[0]).toMatchObject({ kind: "existing", conv: { key: "tab-9" } });
    await click(byText("button", "chat.team.link"));
    await click(host.querySelector("[aria-label^='chat.team.form.agent']"));
    expect(item("Conversa aberta")).toBeUndefined();
  });

  it("descartar o rascunho esvazia o painel", async () => {
    await mount(<DraftTeamPanel cards={[]} />);
    await click(byText("button", "chat.team.link"));
    await click(byText("button", "chat.team.draft.add"));
    await act(async () => { clearDraft(); });
    expect(useTeamDraft.getState().members).toEqual([]);
    expect(host.textContent).toContain("chat.team.draft.noAgent");
  });
});
