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

import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";

import type { TeamView } from "../ipc";
import { TeamNodeBadge } from "../TeamNodeBadge";
import { useTeamStore } from "../teamStore";

const TEAM: TeamView = {
  id: "t1", orchestrator: "lead", agentId: "claude-code", label: "Lead", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 2,
  members: [{ teamId: "t1", member: "a", agentId: "codex", label: "Codex", role: "qa", model: null, policy: "read", branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: true }],
};
const tab = (id: string): Tab => ({ id, title: id, cwd: "/repo", agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: null, openedAt: 1 }) as Tab;

let root: Root;
let host: HTMLDivElement;
async function render(ref: string) {
  await act(async () => { root.render(<TeamNodeBadge tabId={ref} />); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useTabsStore.setState({ tabs: [tab("lead"), tab("a"), tab("solto")] } as never);
  backend.teams = [TEAM];
  useTeamStore.setState({ teams: [TEAM], loaded: true, feeds: {}, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("o selo do time no cartão do canvas", () => {
  it("mostra o estado e a política do integrante", async () => {
    await render("a");
    expect(host.textContent).toContain("chat.team.state.idle");
    expect(host.textContent).toContain("chat.team.policy.read");
  });

  it("o orquestrador mostra o estado dele, sem política gravada", async () => {
    await render("lead");
    expect(host.textContent).toContain("chat.team.state.idle");
    expect(host.textContent).not.toContain("chat.team.policy.read");
  });

  it("um terminal fora do time não desenha nada", async () => {
    await render("solto");
    expect(host.textContent).toBe("");
  });
});
