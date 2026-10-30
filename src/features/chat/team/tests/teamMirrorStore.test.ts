// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** O backend do time, em memória: o que os comandos `chat_team_*` gravam. */
const backend = vi.hoisted(() => ({ team: null as Record<string, unknown> | null, calls: [] as [string, Record<string, unknown>][] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    backend.calls.push([cmd, args]);
    const team = backend.team as { members: Record<string, unknown>[] } | null;
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (cmd === "chat_team_list") return Promise.resolve(team ? [team] : []);
    if (cmd === "chat_team_feed") return Promise.resolve([]);
    if (cmd === "chat_team_link" && team) {
      team.members.push({
        teamId: "t1", member: input.member, agentId: input.agentId, label: input.label, role: input.role || "generalist", model: null, policy: input.policy ?? "ask",
        branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: input.subagent === true,
      });
      return Promise.resolve({ member: team.members[team.members.length - 1], briefing: "", roleLabel: "" });
    }
    if (cmd === "chat_team_unlink" && team) {
      team.members = team.members.filter((m) => m.member !== args.member);
      return Promise.resolve(true);
    }
    if (cmd === "chat_team_update" && team) {
      const m = team.members.find((x) => x.member === input.member);
      if (m) Object.assign(m, Object.fromEntries(Object.entries({ role: input.role, subagent: input.subagent }).filter(([, v]) => v !== undefined)));
      return Promise.resolve(m);
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import type { Tab } from "@/features/tabs/types";

import type { TeamView } from "../ipc";

// Os módulos são carregados de novo a cada teste: a linha de base e o "já começou" do store são de módulo.
let canvas: typeof import("@/features/canvas/store");
let tabsStore: typeof import("@/features/tabs/store");
let teamStore: typeof import("../teamStore");
let KEY = "";
const canvasActions = () => canvas.canvasActions;
const tab = (id: string, agentId: string): Tab => ({ id, title: id, cwd: "/repo", agentId, agentLabel: agentId, command: agentId, ptyId: null, openedAt: 1 }) as Tab;
const calls = (cmd: string) => backend.calls.filter(([c]) => c === cmd);
const board = () => canvas.useCanvasStore.getState().boards[KEY]!;

async function settle() {
  await vi.advanceTimersByTimeAsync(500);
  await vi.advanceTimersByTimeAsync(500);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  canvas = await import("@/features/canvas/store");
  tabsStore = await import("@/features/tabs/store");
  teamStore = await import("../teamStore");
  const { emptyBoard, reconcile } = await import("@/features/canvas/board");
  KEY = canvas.boardKey("/repo");
  backend.calls = [];
  const team = { id: "t1", orchestrator: "lead", agentId: "claude-code", label: "Lead", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 1, members: [] };
  backend.team = team;
  tabsStore.useTabsStore.setState({ hydrated: true, tabs: [tab("lead", "claude-code"), tab("a", "codex"), tab("sh", "bash")] } as never);
  canvas.useCanvasStore.setState({ loaded: true, boards: { [KEY]: { ...reconcile(emptyBoard(), ["lead", "a", "sh"]), orchestrators: ["lead"] } } });
  teamStore.useTeamStore.setState({ teams: [team as unknown as TeamView], loaded: true, feeds: {}, targets: {}, told: {}, adding: {} });
  teamStore.startTeams();
  await teamStore.syncTeamCanvas(team as unknown as TeamView);
  backend.calls = [];
});
afterEach(() => { vi.useRealTimers(); });

describe("o espelho canvas -> chat no app", () => {
  it("corda nova liga o integrante uma vez e depois o canvas e o time ficam quietos", async () => {
    canvasActions().connect(KEY, "lead", "a");
    canvasActions().setRole(KEY, "a", "QA", true);
    await settle();
    expect(calls("chat_team_link")).toHaveLength(1);
    expect(calls("chat_team_link")[0]![1].input).toMatchObject({ member: "a", subagent: true });
    const edges = board().edges.length;
    backend.calls = [];
    await settle();
    expect(backend.calls.filter(([c]) => ["chat_team_link", "chat_team_unlink", "chat_team_update"].includes(c))).toEqual([]);
    expect(board().edges).toHaveLength(edges);
    expect(board().subagents).toEqual(["a"]);
  });

  it("corda removida desliga o integrante, uma vez", async () => {
    canvasActions().connect(KEY, "lead", "a");
    await settle();
    backend.calls = [];
    canvasActions().disconnectPair(KEY, "lead", "a");
    await settle();
    expect(calls("chat_team_unlink")).toHaveLength(1);
    await settle();
    expect(calls("chat_team_unlink")).toHaveLength(1);
    expect(calls("chat_team_link")).toHaveLength(0);
    expect(board().edges.filter((e) => e.a === "a" || e.b === "a")).toEqual([]);
  });

  it("papel e subagente mudados no canvas atualizam o integrante", async () => {
    canvasActions().connect(KEY, "lead", "a");
    await settle();
    backend.calls = [];
    canvasActions().setRole(KEY, "a", "Arquiteto", true);
    await settle();
    expect(calls("chat_team_update")).toHaveLength(1);
    expect(calls("chat_team_update")[0]![1].input).toMatchObject({ member: "a", role: "Arquiteto", subagent: true });
  });

  it("tirar a coroa não desfaz o time nem gera comando", async () => {
    canvasActions().connect(KEY, "lead", "a");
    await settle();
    backend.calls = [];
    canvasActions().toggleOrchestrator(KEY, "lead");
    await settle();
    expect(backend.calls.filter(([c]) => ["chat_team_link", "chat_team_unlink", "chat_team_update", "chat_team_dissolve"].includes(c))).toEqual([]);
    expect((backend.team as { members: unknown[] }).members).toHaveLength(1);
  });

  it("corda para um terminal comum (shell) não vira integrante", async () => {
    canvasActions().connect(KEY, "lead", "sh");
    await settle();
    expect(calls("chat_team_link")).toHaveLength(0);
  });
});
