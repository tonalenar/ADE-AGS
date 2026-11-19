// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockedInvoke }));

import type { Board } from "@/features/canvas/board";
import { emptyBoard } from "@/features/canvas/board";
import { boardKey, initCanvasSync, missionBoardKey, sessionBoardKey, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";

const tab = (id: string) => ({ id, cwd: "/p", title: id, agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: 1, openedAt: 1 });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mockedInvoke.mockReset();
  useTabsStore.setState({ tabs: [], hydrated: false });
  useCanvasStore.setState({ boards: {}, modes: {}, loaded: false, loadError: null, saveError: null });
  useTeamIndex.setState({ teams: [], loaded: true });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("migração dos canvases de sessão", () => {
  it("move os artefatos da conversa para o canvas próprio: a pasta não fica com corda nem coroa dela", async () => {
    const folder = boardKey("/p");
    const legacy: Board = {
      ...emptyBoard(),
      nodes: { a: { x: 10, y: 20, w: 500, h: 300 } },
      notes: { "note-a": { name: "A", content: "nota", box: { x: 1, y: 2, w: 200, h: 100 } } },
      edges: [{ id: "e-note", a: "a", b: "note-a" }],
      orchestrators: ["a"],
      roles: { a: "" },
      subagents: ["a"],
    };
    mockedInvoke.mockResolvedValue({ [folder]: legacy });
    useTabsStore.setState({ tabs: [tab("a") as never], hydrated: true });

    const stop = initCanvasSync("main");
    await Promise.resolve();
    stop();

    const boards = useCanvasStore.getState().boards;
    expect(boards[sessionBoardKey("/p", "a")]).toMatchObject({
      nodes: { a: legacy.nodes.a },
      notes: { "note-a": legacy.notes["note-a"] },
      edges: [{ id: "e-note", a: "a", b: "note-a" }],
      orchestrators: ["a"],
      roles: { a: "" },
      subagents: ["a"],
    });
    expect(boards[folder]).toMatchObject({ nodes: {}, notes: {}, edges: [], orchestrators: [], roles: {}, subagents: [] });
  });

  it("sem a lista de times, a conversa antiga fica na pasta com tudo o que tinha", async () => {
    useTeamIndex.setState({ teams: [], loaded: false });
    const folder = boardKey("/p");
    const legacy: Board = { ...emptyBoard(), nodes: { a: { x: 10, y: 20, w: 500, h: 300 } }, orchestrators: ["a"], roles: { a: "QA" } };
    mockedInvoke.mockResolvedValue({ [folder]: legacy });
    useTabsStore.setState({ tabs: [tab("a") as never], hydrated: true });

    const stop = initCanvasSync("main");
    await Promise.resolve();

    expect(useCanvasStore.getState().boards[folder]).toEqual(legacy);
    expect(useCanvasStore.getState().boards[sessionBoardKey("/p", "a")]).toBeUndefined();
    // A lista chegou: agora a conversa vai para o canvas próprio, com a coroa e o papel.
    useTeamIndex.setState({ teams: [], loaded: true });
    expect(useCanvasStore.getState().boards[sessionBoardKey("/p", "a")]).toMatchObject({ orchestrators: ["a"], roles: { a: "QA" } });
    stop();
  });

  it("a conversa que já é de uma missão fica lá, e o canvas dela não muda", async () => {
    const folder = boardKey("/p");
    const mission = missionBoardKey("/p", "m1");
    const legacy: Board = {
      ...emptyBoard(),
      nodes: { a: { x: 10, y: 20, w: 500, h: 300 } },
      edges: [{ id: "e1", a: "a", b: "b" }],
    };
    const special = { ...emptyBoard(), nodes: { a: { x: 0, y: 0, w: 200, h: 100 } } };
    mockedInvoke.mockResolvedValue({ [folder]: legacy, [mission]: special });
    useTabsStore.setState({ tabs: [tab("a") as never], hydrated: true });

    const stop = initCanvasSync("main");
    await Promise.resolve();
    stop();

    expect(useCanvasStore.getState().boards[mission]).toEqual(special);
    expect(useCanvasStore.getState().boards[sessionBoardKey("/p", "a")]).toBeUndefined();
  });
});
