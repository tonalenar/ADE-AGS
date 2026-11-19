// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockedInvoke }));

import type { Board } from "@/features/canvas/board";
import { emptyBoard } from "@/features/canvas/board";
import { boardKey, initCanvasSync, missionBoardKey, sessionBoardKey, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";

const tab = (id: string) => ({ id, cwd: "/p", title: id, agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: 1, openedAt: 1 });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mockedInvoke.mockReset();
  useTabsStore.setState({ tabs: [], hydrated: false });
  useCanvasStore.setState({ boards: {}, modes: {}, loaded: false, loadError: null, saveError: null });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("sincronização aditiva dos canvases de sessão", () => {
  it("copia os artefatos da conversa e preserva o canvas antigo inteiro", async () => {
    const folder = boardKey("/p");
    const legacy: Board = {
      ...emptyBoard(),
      nodes: { a: { x: 10, y: 20, w: 500, h: 300 } },
      notes: { "note-a": { name: "A", content: "nota", box: { x: 1, y: 2, w: 200, h: 100 } } },
      edges: [{ id: "e-note", a: "a", b: "note-a" }, { id: "e-old", a: "a", b: "b" }],
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
    expect(boards[folder]).toEqual(legacy);
    expect(boards[sessionBoardKey("/p", "a")]).toMatchObject({
      nodes: { a: legacy.nodes.a },
      notes: { "note-a": legacy.notes["note-a"] },
      edges: [{ id: "e-note", a: "a", b: "note-a" }],
      orchestrators: ["a"],
      roles: { a: "" },
      subagents: ["a"],
    });
  });

  it("preserva como snapshot o canvas de pasta quando a conversa já pertence a uma missão", async () => {
    const folder = boardKey("/p");
    const mission = missionBoardKey("/p", "m1");
    const legacy: Board = {
      ...emptyBoard(),
      nodes: { a: { x: 10, y: 20, w: 500, h: 300 }, b: { x: 600, y: 20, w: 500, h: 300 } },
      edges: [{ id: "e1", a: "a", b: "b" }],
      orchestrators: ["a"],
      roles: { b: "QA" },
      subagents: ["b"],
    };
    const special = { ...emptyBoard(), nodes: { a: { x: 0, y: 0, w: 200, h: 100 } } };
    mockedInvoke.mockResolvedValue({ [folder]: legacy, [mission]: special });
    useTabsStore.setState({ tabs: [tab("a") as never], hydrated: true });

    const stop = initCanvasSync("main");
    await Promise.resolve();
    stop();

    expect(useCanvasStore.getState().boards[folder]).toEqual(legacy);
    expect(useCanvasStore.getState().boards[mission]).toEqual(special);
  });
});
