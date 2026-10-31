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
import { TeamTabMarks } from "../TeamTabMarks";
import { useTeamStore } from "../teamStore";

const member = (ref: string, role: string, subagent: boolean) => ({ teamId: "t1", member: ref, agentId: "codex", label: ref, role, model: null, policy: "read" as const, branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent });
const TEAM: TeamView = { id: "t1", orchestrator: "lead", agentId: "claude-code", label: "Lead", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 3, members: [member("a", "qa", true), member("b", "backend", false)] };
const tab = (id: string): Tab => ({ id, title: id, cwd: "/repo", agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: 1, openedAt: 1 }) as Tab;

let root: Root;
let host: HTMLDivElement;
const render = (id: string, compact = false) => act(async () => { root.render(<TeamTabMarks tabId={id} compact={compact} />); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  backend.teams = [TEAM];
  useTabsStore.setState({ tabs: [tab("lead"), tab("a"), tab("b"), tab("solto")] } as never);
  useTeamStore.setState({ teams: [TEAM], loaded: true, feeds: {}, targets: {}, told: {}, adding: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("as marcas do time nas abas e na grade", () => {
  it("o orquestrador leva a marca de orquestrador", async () => {
    await render("lead");
    expect(host.textContent).toContain("canvas.orchestrator");
    expect(host.textContent).not.toContain("role.subagentTag");
  });
  it("o integrante leva o papel, a etiqueta de subagente, o estado e a política", async () => {
    await render("a");
    expect(host.textContent).toContain("chat.team.roles.qa");
    expect(host.textContent).toContain("role.subagentTag");
    expect(host.textContent).toContain("chat.team.state.idle");
    expect(host.textContent).toContain("chat.team.policy.read");
  });
  it("quem não é subagente não leva a etiqueta", async () => {
    await render("b");
    expect(host.textContent).toContain("chat.team.roles.backend");
    expect(host.textContent).not.toContain("role.subagentTag");
  });
  it("na aba (compacto) só a etiqueta curta, sem estado", async () => {
    await render("a", true);
    expect(host.textContent).toContain("chat.team.roles.qa");
    expect(host.textContent).not.toContain("chat.team.state");
  });
  it("fora de um time não desenha nada", async () => {
    await render("solto");
    expect(host.textContent).toBe("");
  });
});
