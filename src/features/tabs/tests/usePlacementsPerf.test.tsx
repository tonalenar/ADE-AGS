/** @vitest-environment happy-dom */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalStats = vi.hoisted(() => ({
  rendersByTab: new Map<string, number>(),
  mountsByTab: new Map<string, number>(),
  unmountsByTab: new Map<string, number>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/features/terminal/LazyTerminal", () => ({
  Terminal: function FakeTerminal({ tabId }: { tabId: string }) {
    terminalStats.rendersByTab.set(tabId, (terminalStats.rendersByTab.get(tabId) ?? 0) + 1);
    useEffect(() => {
      terminalStats.mountsByTab.set(tabId, (terminalStats.mountsByTab.get(tabId) ?? 0) + 1);
      return () => {
        terminalStats.unmountsByTab.set(tabId, (terminalStats.unmountsByTab.get(tabId) ?? 0) + 1);
      };
    }, [tabId]);
    return createElement("div", { "data-terminal": tabId });
  },
}));

import { useUiStore } from "@/app/uiStore";
import { emptyBoard } from "@/features/canvas/board";
import { canvasActions, useCanvasStore, windowModeKey } from "@/features/canvas/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import { usePlacements, type Placements } from "../layout/layoutStore";
import { useTabsStore } from "../store";
import { ViewTabsHost } from "../ViewTabsHost";
import { useViewTabsStore } from "../viewStore";

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
  terminalStats.rendersByTab.clear();
  terminalStats.mountsByTab.clear();
  terminalStats.unmountsByTab.clear();
  useTeamIndex.setState({ teams: [], loaded: true });
  useUiStore.setState({ chatMode: false, shellMode: "workspace" });
  useTabsStore.setState({
    tabs: [makeTab("t1"), makeTab("t2")] as never,
    activeTabId: "t1",
  });
  useViewTabsStore.setState({
    views: [{ id: "v1", kind: "file", cwd: "/proj", path: "/proj/a.ts", title: "a.ts" }] as never,
    activeViewId: null,
    keepMountedIds: [],
  });
  useCanvasStore.setState({
    boards: {
      "main|/proj": {
        ...emptyBoard(),
        nodes: {
          t1: { x: 0, y: 0, w: 600, h: 400 },
          t2: { x: 9000, y: 0, w: 600, h: 400 },
        },
      },
    },
    modes: { [windowModeKey()]: "canvas" },
    grids: {},
    liveRects: { t1: { left: 10, top: 20, width: 600, height: 400 } },
    desktopRects: {},
    loaded: true,
    activeThread: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("usePlacements estável, TerminalPanel e ViewTabsHost (F-R12)", () => {
  it("usePlacements mantém a mesma referência quando o componente re-renderiza sem mudança nas entradas", async () => {
    const snapshots: Placements[] = [];
    function Probe({ tick }: { tick: number }) {
      void tick;
      snapshots.push(usePlacements());
      return null;
    }

    await act(async () => root.render(<Probe tick={0} />));
    await act(async () => root.render(<Probe tick={1} />));

    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toBe(snapshots[0]);
    expect(snapshots[1]!.visible).toBe(snapshots[0]!.visible);
  });

  it("mudar liveRects durante o pan no canvas não desmonta terminais e não re-renderiza abas sem mudança de retângulo", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/workspace"]}>
          <TerminalPanel />
        </MemoryRouter>,
      );
    });

    expect(terminalStats.mountsByTab.get("t1")).toBe(1);
    expect(terminalStats.mountsByTab.get("t2")).toBe(1);
    const t2RendersBefore = terminalStats.rendersByTab.get("t2") ?? 0;

    for (let i = 1; i <= 10; i++) {
      await act(async () => {
        canvasActions.setLiveRects({ t1: { left: 10 + i * 8, top: 20, width: 600, height: 400 } });
      });
    }

    // Nenhum terminal foi desmontado (regra de ouro: desmontar mata o PTY).
    expect(terminalStats.unmountsByTab.get("t1") ?? 0).toBe(0);
    expect(terminalStats.unmountsByTab.get("t2") ?? 0).toBe(0);
    // A aba t2 (fora da tela, placement inalterado) não re-renderizou com o pan de t1.
    expect(terminalStats.rendersByTab.get("t2")).toBe(t2RendersBefore);
  });

  it("ViewTabsHost e usePlacements({ trackCanvasAgents: false }) não re-renderizam quando liveRects muda no pan do canvas", async () => {
    let probeRenders = 0;
    const seen: Placements[] = [];
    function ViewPlacementsProbe() {
      probeRenders += 1;
      seen.push(usePlacements({ trackCanvasAgents: false }));
      return null;
    }

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/workspace"]}>
          <ViewPlacementsProbe />
          <ViewTabsHost />
        </MemoryRouter>,
      );
    });

    const rendersBefore = probeRenders;
    for (let i = 1; i <= 10; i++) {
      await act(async () => {
        canvasActions.setLiveRects({ t1: { left: 10 + i * 8, top: 20, width: 600, height: 400 } });
      });
    }

    expect(probeRenders).toBe(rendersBefore);
    expect(seen).toHaveLength(1);
  });
});
