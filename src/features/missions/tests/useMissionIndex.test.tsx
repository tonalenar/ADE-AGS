/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { emptyBoard } from "@/features/canvas/board";
import { canvasActions, missionBoardKey, useCanvasStore } from "@/features/canvas/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { useTabsStore } from "@/features/tabs/store";
import { useMissionIndex } from "../groups";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const makeTab = (id: string, cwd = "/proj") => ({
  id,
  title: `Agente ${id}`,
  cwd,
  agentId: "codex",
  agentLabel: "Codex",
  command: "codex",
  ptyId: null,
  openedAt: 1,
});

beforeEach(() => {
  vi.useFakeTimers();
  useTeamIndex.setState({ teams: [], loaded: true });
  useTabsStore.setState({ tabs: [], activeTabId: null } as never);
  useCanvasStore.setState({
    boards: {},
    modes: {},
    grids: {},
    liveRects: {},
    desktopRects: {},
    loaded: true,
    loadError: null,
    saveError: null,
    activeThread: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useMissionIndex sem JSON.stringify e estável (F-R4)", () => {
  it("não chama JSON.stringify/JSON.parse e não re-renderiza quando canvas muda sem alterar pertença de missão", async () => {
    const key = missionBoardKey("/proj", "m1");
    useTabsStore.setState({ tabs: [makeTab("t1"), makeTab("t2")] as never, activeTabId: "t1" });
    useCanvasStore.setState({
      boards: {
        [key]: {
          ...emptyBoard(),
          nodes: { t1: { x: 0, y: 0, w: 500, h: 300 } },
        },
      },
    });

    let renders = 0;
    const seen: Array<Record<string, string>> = [];
    function Probe() {
      renders += 1;
      const idx = useMissionIndex();
      seen.push(idx);
      return null;
    }

    const stringifySpy = vi.spyOn(JSON, "stringify");
    const parseSpy = vi.spyOn(JSON, "parse");

    try {
      await act(async () => {
        root.render(<><Probe /><Probe /></>);
      });
      expect(seen[0]).toEqual({ t1: "m1" });
      expect(seen[0]).toBe(seen[1]);
      expect(stringifySpy).not.toHaveBeenCalled();
      expect(parseSpy).not.toHaveBeenCalled();

      const rendersBefore = renders;

      // Mudanças frequentes do canvas que não alteram a pertença de missão.
      await act(async () => {
        canvasActions.setLiveRects({ t1: { left: 10, top: 20, width: 500, height: 300 } });
        canvasActions.setLiveRects({ t1: { left: 25, top: 40, width: 500, height: 300 } });
        useCanvasStore.setState({ desktopRects: { g1: { left: 1, top: 2, width: 300, height: 200 } } });
        canvasActions.moveNode(key, "t1", { x: 250, y: 180 });
      });

      expect(renders).toBe(rendersBefore);
      expect(stringifySpy).not.toHaveBeenCalled();
      expect(parseSpy).not.toHaveBeenCalled();

      // Quando a pertença realmente muda, o índice atualiza.
      await act(async () => {
        canvasActions.placeNode(key, "t2", { x: 600, y: 0, w: 500, h: 300 });
      });

      expect(seen[seen.length - 1]).toEqual({ t1: "m1", t2: "m1" });
      expect(stringifySpy).not.toHaveBeenCalled();
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
      parseSpy.mockRestore();
    }
  });
});
