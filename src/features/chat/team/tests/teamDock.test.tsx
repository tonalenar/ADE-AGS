// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ teams: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => Promise.resolve(cmd === "chat_team_list" ? backend.teams : []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
// Os componentes do chat já têm testes próprios: aqui só a gaveta.
vi.mock("../TeamPanel", () => ({ TeamPanel: ({ conversation }: { conversation: { tabId: string } | null }) => <div data-testid="painel">{conversation?.tabId}</div> }));
vi.mock("../../permissions/PermissionsInbox", () => ({ PermissionsInbox: () => <div data-testid="caixa" /> }));
vi.mock("../../permissions/PermissionsManager", () => ({ PermissionsManager: () => <div data-testid="gerente" /> }));

import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import { useUiStore } from "@/app/uiStore";

import { setInboxOpen } from "../../permissions/permissionsStore";
import type { TeamView } from "../ipc";
import { TeamDock } from "../TeamDock";
import { useTeamStore } from "../teamStore";

const TEAM: TeamView = {
  id: "t1", orchestrator: "lead", agentId: "claude-code", label: "Lead", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 2,
  members: [{ teamId: "t1", member: "a", agentId: "codex", label: "Codex", role: "qa", model: null, policy: "ask", branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: false }],
};
const tab = (id: string): Tab => ({ id, title: id, cwd: "/repo", agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: 1, openedAt: 1 }) as Tab;

let root: Root;
let host: HTMLDivElement;
const render = () => act(async () => { root.render(<TeamDock />); });
const buttons = () => [...host.querySelectorAll("button")];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  backend.teams = [TEAM];
  setInboxOpen(false);
  useUiStore.setState({ shellMode: "tabs" } as never);
  useTabsStore.setState({ tabs: [tab("lead"), tab("a"), tab("solto")], activeTabId: "a" } as never);
  useTeamStore.setState({ teams: [TEAM], loaded: true, feeds: {}, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  document.body.querySelectorAll("[role=dialog]").forEach((n) => n.remove());
});

describe("a gaveta do time nas Abas", () => {
  it("fora de um time não aparece nada (nem o gerente de permissões)", async () => {
    useTabsStore.setState({ activeTabId: "solto" } as never);
    await render();
    expect(host.textContent).toBe("");
    expect(host.querySelector("[data-testid=gerente]")).toBeNull();
  });

  it("num time mostra os dois botões e o gerente de permissões", async () => {
    await render();
    expect(buttons().map((b) => b.textContent)).toEqual(["chat.team.title", "chat.inbox.title"]);
    expect(host.querySelector("[data-testid=gerente]")).not.toBeNull();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("o botão Time abre o painel com a aba ativa como conversa", async () => {
    await render();
    await act(async () => { buttons()[0]!.click(); });
    expect(document.querySelector("[data-testid=painel]")?.textContent).toBe("a");
    expect(document.querySelector("[data-testid=caixa]")).toBeNull();
  });

  it("o botão Permissões (e o atalho, que liga inboxOpen) abre a caixa no lugar do painel", async () => {
    await render();
    await act(async () => { buttons()[1]!.click(); });
    expect(document.querySelector("[data-testid=caixa]")).not.toBeNull();
    await act(async () => { setInboxOpen(false); });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    await act(async () => { setInboxOpen(true); });
    expect(document.querySelector("[data-testid=caixa]")).not.toBeNull();
  });

  it("no modo chat a gaveta não aparece (o chat tem a dele)", async () => {
    useUiStore.setState({ chatMode: true, shellMode: "chat" } as never);
    await render();
    expect(host.textContent).toBe("");
  });
});
