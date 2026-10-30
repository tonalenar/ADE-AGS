// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ calls: [] as string[], feed: [] as unknown[], teams: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    backend.calls.push(cmd);
    if (cmd === "chat_team_list") return Promise.resolve(backend.teams);
    if (cmd === "chat_team_feed") return Promise.resolve(backend.feed);
    if (cmd === "chat_team_handoff") return Promise.resolve({ id: 7, from: "thread:x", handoff: { summary: "Resumo longo da entrega do integrante", changed_files: [], tests: [] } });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && "count" in o ? `${key}:${o.count}` : key), i18n: { language: "pt-BR" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

import type { ConversationCard } from "../../chatModel";
import type { TeamFeedItem, TeamView } from "../ipc";
import { TeamThreadFeed } from "../TeamThreadFeed";
import { useTeamStore } from "../teamStore";

const TEAM: TeamView = {
  id: "t1", orchestrator: "tab-lead", agentId: "claude-code", label: "Claude Code", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 1,
  members: [{ teamId: "t1", member: "thread:x", agentId: "codex", label: "Codex", role: "backend", model: null, policy: "edits", branch: null, worktree: null, origin: "new", position: 0, createdAt: 1, updatedAt: 1 }],
};
const FEED: TeamFeedItem[] = [
  { id: 1, kind: "delegation", member: "thread:x", memberName: "Codex", task: "Fazer o backend", state: "delivered", at: 1, handoff: null },
  { id: 2, kind: "delivery", member: "thread:x", memberName: "Codex", task: "", state: "delivered", at: 2, handoff: 7 },
];
const lead: ConversationCard = {
  tabId: "tab-lead", title: "Claude Code", project: "repo", cwd: "/repo", branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code", starting: false, active: true, openedAt: 1,
};

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  backend.calls = [];
  backend.teams = [TEAM];
  backend.feed = FEED;
  useTeamStore.setState({ teams: [TEAM], feeds: { t1: FEED }, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host.remove();
});

describe("o fio do time", () => {
  it("fica recolhido numa linha só e não lê as entregas enquanto fechado", async () => {
    await act(async () => { root!.render(<TeamThreadFeed conversation={lead} cards={[lead]} />); });
    const toggle = host.querySelector("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("chat.team.feed.title");
    expect(toggle.textContent).toContain("chat.team.feed.delegations:1");
    expect(toggle.textContent).toContain("chat.team.feed.deliveries:1");
    expect(host.textContent).not.toContain("Fazer o backend");
    expect(backend.calls).not.toContain("chat_team_handoff");
  });

  it("abre ao clicar e mostra a entrega em uma linha truncada", async () => {
    await act(async () => { root!.render(<TeamThreadFeed conversation={lead} cards={[lead]} />); });
    await act(async () => { (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click(); });
    expect(host.textContent).toContain("Fazer o backend");
    expect(host.textContent).toContain("Resumo longo da entrega do integrante");
    const summary = [...host.querySelectorAll("span")].find((s) => s.textContent === "Resumo longo da entrega do integrante")!;
    expect(summary.className).toContain("truncate");
  });
});
