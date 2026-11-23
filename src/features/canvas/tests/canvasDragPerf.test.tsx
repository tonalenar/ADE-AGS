/** @vitest-environment happy-dom */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedFlowProps {
  nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: unknown; selected?: boolean }>;
  onNodesChange?: (changes: unknown[]) => void;
  onNodeDragStop?: (event: unknown, node: { id: string; position: { x: number; y: number } }, nodes?: Array<{ id: string; position: { x: number; y: number } }>) => void;
  onViewportChange?: (vp: { x: number; y: number; zoom: number }) => void;
  onMoveEnd?: (event: unknown, vp: { x: number; y: number; zoom: number }) => void;
}

const harness = vi.hoisted(() => ({
  invoke: vi.fn(),
  flow: null as CapturedFlowProps | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => harness.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("neogestify-ui-components", async (importOriginal) => ({
  ...(await importOriginal<typeof import("neogestify-ui-components")>()),
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("@/features/terminal/terminalRegistry", () => ({
  screenOf: vi.fn(() => ({ lines: [] })),
  sendKeysToTab: vi.fn(() => true),
}));
vi.mock("@/features/terminal/safeWrite", () => ({ sendAutonomous: vi.fn() }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: () => null }));
vi.mock("@/shared/ui/ContextMenu", () => ({ ContextMenu: () => null }));
vi.mock("../CanvasToolbar", () => ({ CanvasToolbar: () => null }));
vi.mock("../CanvasDock", () => ({ CanvasDock: () => null }));
vi.mock("../ChatPanel", () => ({ ChatPanel: () => null }));
vi.mock("../DrawingLayer", () => ({ DrawingLayer: () => null }));
vi.mock("../DeviceFloatBar", () => ({ DeviceFloatBar: () => null, PhoneModeIcon: () => null }));
vi.mock("../DeviceNode", () => ({ DeviceNode: () => null }));
vi.mock("../ExtraNodes", () => ({ ImageNode: () => null, TextNode: () => null }));
vi.mock("../FolderNode", () => ({ FolderNode: () => null, baseName: (p: string) => p }));
vi.mock("../ThreadNode", () => ({ ThreadNode: () => null }));
vi.mock("../RemoteNode", () => ({ RemoteNode: () => null }));
vi.mock("../SubagentCardNode", () => ({ SubagentCardNode: () => null }));
vi.mock("../CanvasSchedulesPanel", () => ({ CanvasSchedulesPanel: () => null }));
vi.mock("../RoleEditDialog", () => ({ RoleEditDialog: () => null }));
vi.mock("../cords", () => ({
  CORD_MAGNET: 12,
  CordConnectionLine: () => null,
  CordEdge: () => null,
  CordPort: () => null,
  cordColor: () => "#000",
  flashNode: vi.fn(),
}));
vi.mock("../design/DesignPanel", () => ({ DesignPanel: () => null }));
vi.mock("../design/chooseProposal", () => ({ chooseOnBoard: vi.fn() }));
vi.mock("../design/DesignNodes", () => ({
  BOARD_NODE_PREFIX: "design-board:",
  FRAME_NODE_PREFIX: "design-frame:",
  DesignBoardNode: () => null,
  DesignFrameNode: () => null,
  DesignActionsContext: { Provider: ({ children }: { children: ReactNode }) => children },
  isDesignNodeId: (id: string) => id.startsWith("design-"),
}));
vi.mock("../design/useScopedDesigns", () => ({
  useScopedDesigns: () => ({ details: [], boards: [], groups: [], empty: true, reload: vi.fn(), markSeen: vi.fn(), dismissNotice: vi.fn(), unseen: false, notice: null, loadError: null }),
}));
vi.mock("@/features/desktopApps/GeminiDesktopNode", () => ({ GeminiDesktopNode: () => null }));
vi.mock("@/features/simulator/SimulatorNode", () => ({ SimulatorNode: () => null }));
vi.mock("@/features/simulator/store", () => ({ refreshDevices: vi.fn(), useSimulatorStore: () => ({ devices: [] }) }));
vi.mock("@/shared/brand/Pet", () => ({ PetCard: () => null, usePetStatus: () => ({ idle: true, progress: 0 }) }));
vi.mock("@/features/peerQueue/PeerQueueBadge", () => ({ PeerQueueBadge: () => null }));
vi.mock("@/features/chat/team/TeamNodeBadge", () => ({ TeamNodeBadge: () => null }));
vi.mock("@/features/compare/ComparisonBar", () => ({ ComparisonBar: () => null }));
vi.mock("@/features/compare/store", () => ({ openCompareDialog: vi.fn() }));
vi.mock("@/features/missions/groups", () => ({ useMissionIndex: () => ({}) }));
vi.mock("../cliStatus", () => ({ useCliOutdatedNotice: () => null }));
vi.mock("../portalLifetime", () => ({ usePortalViewLifetime: () => {} }));
vi.mock("../useBoardHarnessTasks", () => ({ useBoardHarnessTasks: () => [] }));
vi.mock("@/features/settings/remote/ipc", () => ({ remoteClientsList: vi.fn(async () => []) }));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  ConnectionMode: { Loose: "loose" },
  NodeResizer: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  ReactFlow: (props: CapturedFlowProps) => {
    harness.flow = props;
    return createElement("div", { "data-testid": "rf" });
  },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  useReactFlow: () => ({
    setViewport: vi.fn(),
    getViewport: () => ({ x: 40, y: 40, zoom: 1 }),
    fitView: vi.fn(),
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}));

import { useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { emptyBoard } from "../board";
import { CanvasView } from "../CanvasView";
import { canvasActions, useCanvasStore, windowModeKey } from "../store";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BOARD_KEY = "main|/proj#m:m1";

let host: HTMLDivElement;
let root: Root;

function setupCanvas() {
  const board = {
    ...emptyBoard(),
    viewport: { x: 40, y: 40, zoom: 1 },
    nodes: { t1: { x: 100, y: 100, w: 600, h: 400 } },
    notes: {
      "note-1": { name: "Nota", content: "texto", box: { x: 20, y: 30, w: 300, h: 200 } },
    },
  };
  useTeamIndex.setState({ teams: [], loaded: true });
  useTabsStore.setState({
    tabs: [{ id: "t1", title: "Agente 1 — /proj", cwd: "/proj", agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: null, openedAt: 1 }],
    activeTabId: "t1",
  } as never);
  useCanvasStore.setState({
    boards: { [BOARD_KEY]: board },
    modes: { [windowModeKey()]: "canvas" },
    liveRects: {},
    desktopRects: {},
    loaded: true,
    loadError: null,
    saveError: null,
    activeThread: null,
  });
  useUiStore.setState({ chatMode: false, shellMode: "workspace" });
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.invoke.mockReset().mockResolvedValue(undefined);
  harness.flow = null;
  setupCanvas();
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

async function mountCanvas() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <CanvasView />
      </MemoryRouter>,
    );
  });
}

describe("canvas sem gravação por frame (F-R3)", () => {
  it("arrastar um nó por 20 quadros grava no store apenas 1 vez ao soltar e preserva a posição local durante o arrasto", async () => {
    await mountCanvas();
    expect(harness.flow).not.toBeNull();

    let totalStoreWrites = 0;
    let boardWrites = 0;
    const unsub = useCanvasStore.subscribe((state, prev) => {
      totalStoreWrites += 1;
      if (state.boards !== prev.boards) boardWrites += 1;
    });

    try {
      for (let i = 1; i <= 20; i++) {
        await act(async () => {
          harness.flow!.onNodesChange?.([
            { type: "position", id: "note-1", position: { x: 20 + i * 10, y: 30 + i * 5 }, dragging: true },
          ]);
        });
      }

      // Durante o arrasto, o nó exibido já está na posição local, sem gravar nos stores.
      const dragged = harness.flow!.nodes.find((n) => n.id === "note-1");
      expect(dragged?.position).toEqual({ x: 220, y: 130 });
      expect(boardWrites).toBe(0);
      expect(totalStoreWrites).toBe(0);

      // Ao soltar: React Flow emite dragging: false e onNodeDragStop.
      await act(async () => {
        harness.flow!.onNodesChange?.([
          { type: "position", id: "note-1", dragging: false },
        ]);
        harness.flow!.onNodeDragStop?.({}, { id: "note-1", position: { x: 220, y: 130 } });
      });

      expect(boardWrites).toBe(1);
      expect(totalStoreWrites).toBe(1);
      expect(useCanvasStore.getState().boards[BOARD_KEY]?.notes["note-1"]?.box).toMatchObject({ x: 220, y: 130 });
    } finally {
      unsub();
    }
  });

  it("arrastar um nó de terminal por 15 quadros não grava em boards até o fim e persiste a caixa final", async () => {
    await mountCanvas();

    let boardWrites = 0;
    const unsub = useCanvasStore.subscribe((state, prev) => {
      if (state.boards !== prev.boards) boardWrites += 1;
    });

    try {
      for (let i = 1; i <= 15; i++) {
        await act(async () => {
          harness.flow!.onNodesChange?.([
            { type: "position", id: "t1", position: { x: 100 + i * 12, y: 100 + i * 4 }, dragging: true },
          ]);
        });
      }

      const dragged = harness.flow!.nodes.find((n) => n.id === "t1");
      expect(dragged?.position).toEqual({ x: 280, y: 160 });
      expect(boardWrites).toBe(0);

      await act(async () => {
        harness.flow!.onNodeDragStop?.({}, { id: "t1", position: { x: 280, y: 160 } });
      });

      expect(boardWrites).toBe(1);
      expect(useCanvasStore.getState().boards[BOARD_KEY]?.nodes.t1).toMatchObject({ x: 280, y: 160, w: 600, h: 400 });
    } finally {
      unsub();
    }
  });

  it("mover a tela (pan) sem portal Gemini não grava em desktopRects", async () => {
    await mountCanvas();

    let desktopWrites = 0;
    let totalStoreWrites = 0;
    const unsub = useCanvasStore.subscribe((state, prev) => {
      totalStoreWrites += 1;
      if (state.desktopRects !== prev.desktopRects) desktopWrites += 1;
    });

    try {
      for (let i = 1; i <= 20; i++) {
        await act(async () => {
          harness.flow!.onViewportChange?.({ x: 40 + i * 15, y: 40 + i * 5, zoom: 1 });
        });
      }

      expect(desktopWrites).toBe(0);
      expect(totalStoreWrites).toBe(0);
    } finally {
      unsub();
    }
  });

  it("setLiveRects compara sem JSON.stringify e evita gravar quando os retângulos são iguais", () => {
    const stringifySpy = vi.spyOn(JSON, "stringify");
    try {
      const rect = { left: 10, top: 20, width: 600, height: 400 };
      canvasActions.setLiveRects({ t1: { ...rect } });

      let writes = 0;
      const unsub = useCanvasStore.subscribe(() => { writes += 1; });
      try {
        canvasActions.setLiveRects({ t1: { ...rect } });
        canvasActions.setLiveRects({ t1: { left: 10, top: 20, width: 600, height: 400 } });
        expect(writes).toBe(0);
        expect(stringifySpy).not.toHaveBeenCalled();

        canvasActions.setLiveRects({ t1: { left: 30, top: 20, width: 600, height: 400 } });
        expect(writes).toBe(1);
        expect(stringifySpy).not.toHaveBeenCalled();
      } finally {
        unsub();
      }
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it("redimensionar um nó por vários quadros grava no store apenas 1 vez ao terminar", async () => {
    await mountCanvas();

    let boardWrites = 0;
    const unsub = useCanvasStore.subscribe((state, prev) => {
      if (state.boards !== prev.boards) boardWrites += 1;
    });

    try {
      for (let i = 1; i <= 10; i++) {
        await act(async () => {
          harness.flow!.onNodesChange?.([
            { type: "dimensions", id: "note-1", dimensions: { width: 300 + i * 10, height: 200 + i * 5 }, resizing: true },
          ]);
        });
      }

      expect(boardWrites).toBe(0);

      await act(async () => {
        harness.flow!.onNodesChange?.([
          { type: "dimensions", id: "note-1", dimensions: { width: 400, height: 250 }, resizing: false },
        ]);
      });

      expect(boardWrites).toBe(1);
      expect(useCanvasStore.getState().boards[BOARD_KEY]?.notes["note-1"]?.box).toMatchObject({ w: 400, h: 250 });
    } finally {
      unsub();
    }
  });
});
