// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ teams: [] as unknown[], calls: [] as [string, unknown][] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    backend.calls.push([cmd, args]);
    if (cmd === "chat_team_list") return Promise.resolve(backend.teams);
    if (cmd === "chat_team_feed") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && "count" in o ? `${key}:${o.count}` : o && "n" in o ? `${key}:${o.n}` : key), i18n: { language: "pt-BR" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

import type { ConversationCard } from "../../chatModel";
import type { TeamView } from "../ipc";
import { TeamPanel } from "../TeamPanel";
import { TeamTargetSwitch } from "../TeamComposer";
import { TeamBadge } from "../TeamSidebar";
import { useTeamStore } from "../teamStore";

const TEAM: TeamView = {
  id: "t1", orchestrator: "tab-lead", agentId: "claude-code", label: "Claude Code", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 2,
  members: [{ teamId: "t1", member: "thread:x", agentId: "codex", label: "Codex", role: "frontend", model: "gpt-6.1-sol", policy: "edits", branch: "team/ui", worktree: null, origin: "new", position: 0, createdAt: 1, updatedAt: 1, subagent: false }],
};

const card = (tabId: string, agentId: string, title: string): ConversationCard => ({
  tabId, title, project: "repo", cwd: "/repo", branch: "feat/modo-chat", isWorktree: false, agentId, agentLabel: title, starting: false, active: false, openedAt: 1,
});

let root: Root | null = null;
let host: HTMLDivElement;

async function render(node: React.ReactNode) {
  await act(async () => { root!.render(node); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  backend.teams = [TEAM];
  backend.calls = [];
  useTeamStore.setState({ teams: [TEAM], feeds: {}, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host.remove();
});

describe("o painel Time", () => {
  it("mostra o resumo, o orquestrador primeiro e cada integrante com papel, política e branch", async () => {
    await render(<TeamPanel conversation={card("tab-lead", "claude-code", "Claude Code")} cards={[card("tab-lead", "claude-code", "Claude Code")]} />);
    expect(host.textContent).toContain("chat.team.summary:2");
    const items = host.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("chat.team.roles.orchestrator");
    expect(items[0]!.textContent).toContain("feat/modo-chat");
    expect(items[1]!.textContent).toContain("chat.team.roles.frontend");
    expect(items[1]!.textContent).toContain("chat.team.policy.edits");
    expect(items[1]!.textContent).toContain("team/ui");
    expect(host.textContent).not.toContain("role.subagentTag");
  });

  it("marca com a etiqueta o integrante que é subagente", async () => {
    const sub = { ...TEAM, members: [{ ...TEAM.members[0]!, subagent: true }] };
    useTeamStore.setState({ teams: [sub] });
    backend.teams = [sub];
    await render(<TeamPanel conversation={card("tab-lead", "claude-code", "Claude Code")} cards={[card("tab-lead", "claude-code", "Claude Code")]} />);
    const items = host.querySelectorAll("li");
    expect(items[1]!.textContent).toContain("role.subagentTag");
    expect(items[0]!.textContent).not.toContain("role.subagentTag");
  });

  it("+ Ligar agente abre o formulário com agente, papel e permissões", async () => {
    await render(<TeamPanel conversation={card("tab-lead", "claude-code", "Claude Code")} cards={[]} />);
    const add = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "chat.team.link")!;
    await act(async () => { add.click(); });
    const form = host.querySelector('[role="group"]');
    expect(form?.textContent).toContain("chat.team.form.agent");
    expect(form?.textContent).toContain("chat.team.form.role");
    expect(form?.textContent).toContain("chat.team.form.policy");
    expect(form?.textContent).toContain("chat.team.policyMenu.ask");
  });

  it("uma conversa sem time oferece virar orquestradora", async () => {
    backend.teams = [];
    useTeamStore.setState({ teams: [] });
    await render(<TeamPanel conversation={card("tab-solta", "codex", "Codex")} cards={[]} />);
    expect(host.textContent).toContain("chat.team.empty.make");
  });
});

describe("as peças do time", () => {
  it("o selo do orquestrador conta o time e o segmentado troca o destino", async () => {
    await render(<><TeamBadge convKey="tab-lead" /><TeamTargetSwitch orchestrator="tab-lead" /></>);
    expect(host.textContent).toContain("chat.team.badge:2");
    const lead = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "chat.team.target.lead")!;
    await act(async () => { lead.click(); });
    expect(useTeamStore.getState().targets["tab-lead"]).toBe("lead");
    expect(lead.getAttribute("aria-pressed")).toBe("true");
  });
});
