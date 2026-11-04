// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** O backend do time, em memória: só o que a promoção toca. */
const backend = vi.hoisted(() => ({ teams: [] as Record<string, unknown>[], calls: [] as [string, Record<string, unknown>][] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    backend.calls.push([cmd, args]);
    const input = (args.input ?? {}) as Record<string, unknown> & { members?: Record<string, unknown>[] };
    if (cmd === "chat_team_list") return Promise.resolve(backend.teams);
    if (cmd === "chat_team_feed") return Promise.resolve([]);
    if (cmd === "chat_team_promote") {
      const team = {
        id: `t${backend.teams.length + 1}`, orchestrator: input.orchestrator, agentId: input.agentId, label: input.label, cwd: input.cwd, title: input.title,
        createdAt: 1, updatedAt: 1, headcount: 1 + (input.members?.length ?? 0), origin: "canvas", boardKey: input.boardKey,
        members: (input.members ?? []).map((m, i) => ({
          teamId: "t1", member: m.member, agentId: m.agentId, label: m.label, role: m.role || "generalist", model: null, policy: "ask", branch: null, worktree: null,
          origin: "existing", position: i, createdAt: 1, updatedAt: 1, subagent: m.subagent === true,
        })),
      };
      backend.teams.push(team);
      return Promise.resolve({ team, created: true, adopted: (input.members ?? []).map((m) => m.member), skipped: [] });
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import type { Tab } from "@/features/tabs/types";

let canvas: typeof import("@/features/canvas/store");
let tabsStore: typeof import("@/features/tabs/store");
let teamStore: typeof import("../teamStore");
let boardTs: typeof import("@/features/canvas/board");
let KEY = "";
const tab = (id: string, agentId: string): Tab => ({ id, title: id, cwd: "/repo", agentId, agentLabel: agentId, command: agentId, ptyId: null, openedAt: 1 }) as Tab;
const calls = (cmd: string) => backend.calls.filter(([c]) => c === cmd);
const board = (key = KEY) => canvas.useCanvasStore.getState().boards[key]!;
/** Tudo o que abriria processo, PTY, worktree ou conversa. */
const SPAWNS = ["pty_spawn", "terminal_spawn", "chat_team_worktree", "chat_thread_create", "chat_team_provision_begin", "chat_team_link"];

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
  boardTs = await import("@/features/canvas/board");
  KEY = canvas.boardKey("/repo");
  backend.calls = [];
  backend.teams = [];
  tabsStore.useTabsStore.setState({ hydrated: true, tabs: [tab("lead", "claude-code"), tab("a", "codex"), tab("b", "codex"), tab("sh", "bash")] } as never);
  // O canvas como veio do disco: coroa e uma corda, sem time no chat.
  const loaded = boardTs.addEdge({ ...boardTs.reconcile(boardTs.emptyBoard(), ["lead", "a", "b", "sh"]), orchestrators: ["lead"] }, "lead", "a", "e0");
  canvas.useCanvasStore.setState({ loaded: true, boards: { [KEY]: loaded } });
  teamStore.useTeamStore.setState({ teams: [], loaded: true, feeds: {}, targets: {}, told: {}, adding: {} });
  teamStore.startTeams();
  await settle();
  backend.calls = [];
});
afterEach(() => { vi.useRealTimers(); });

describe("a pessoa mexe no canvas: a coroa vira time do chat", () => {
  it("ao abrir o app nada é promovido (sem backfill)", async () => {
    await settle();
    expect(calls("chat_team_promote")).toHaveLength(0);
    expect(backend.teams).toHaveLength(0);
  });

  it("uma corda nova promove uma vez, sem abrir processo e sem reescrever o canvas", async () => {
    const tabsBefore = tabsStore.useTabsStore.getState().tabs.length;
    const before = board();
    canvas.canvasActions.connect(KEY, "lead", "b");
    await settle();
    const [promote] = calls("chat_team_promote");
    expect(calls("chat_team_promote")).toHaveLength(1);
    expect(promote![1].input).toMatchObject({ orchestrator: "lead", boardKey: KEY });
    expect((promote![1].input as { members: { member: string }[] }).members.map((m) => m.member).sort()).toEqual(["a", "b"]);
    expect(backend.calls.filter(([c]) => SPAWNS.includes(c))).toEqual([]);
    expect(tabsStore.useTabsStore.getState().tabs).toHaveLength(tabsBefore);
    // Só a corda da pessoa mudou no canvas; o time novo não o reescreveu.
    expect(board().edges.map((e) => `${e.a}-${e.b}`).sort()).toEqual([...before.edges.map((e) => `${e.a}-${e.b}`), "lead-b"].sort());
    expect(board().roles).toEqual(before.roles);
    // Quieto depois (idempotente).
    backend.calls = [];
    await settle();
    expect(calls("chat_team_promote")).toHaveLength(0);
    expect(backend.calls.filter(([c]) => ["chat_team_link", "chat_team_unlink", "chat_team_update", "chat_team_unlead"].includes(c))).toEqual([]);
  });

  it("coroar com a corda já posta também promove", async () => {
    canvas.canvasActions.toggleOrchestrator(KEY, "lead");
    await settle();
    backend.calls = [];
    canvas.canvasActions.toggleOrchestrator(KEY, "lead");
    await settle();
    expect(calls("chat_team_promote")).toHaveLength(1);
  });

  it("mexer só na posição de um nó não promove", async () => {
    canvas.canvasActions.moveNode(KEY, "a", { x: 900, y: 900 });
    await settle();
    expect(calls("chat_team_promote")).toHaveLength(0);
  });

  it("canvas de missão nunca promove", async () => {
    const mission = `${KEY}#m:1`;
    canvas.useCanvasStore.setState({ boards: { ...canvas.useCanvasStore.getState().boards, [mission]: { ...boardTs.reconcile(boardTs.emptyBoard(), ["lead", "a"]), orchestrators: ["lead"] } } });
    canvas.canvasActions.connect(mission, "lead", "a");
    await settle();
    expect(calls("chat_team_promote")).toHaveLength(0);
  });
});
