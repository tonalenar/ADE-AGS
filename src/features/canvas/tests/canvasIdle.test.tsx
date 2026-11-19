/** @vitest-environment happy-dom */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  invoke: vi.fn(),
  screenOf: vi.fn(),
  codexUsage: vi.fn(),
  claudeUsage: vi.fn(),
  discoverAgy: vi.fn(),
  agyCli: vi.fn(),
  roObserve: vi.fn(),
  roDisconnect: vi.fn(),
  roTrigger: null as (() => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => spies.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("neogestify-ui-components", async (importOriginal) => ({
  ...(await importOriginal<typeof import("neogestify-ui-components")>()),
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("@/features/terminal/terminalRegistry", () => ({
  screenOf: (...args: unknown[]) => spies.screenOf(...args),
  sendKeysToTab: vi.fn(() => true),
}));

vi.mock("@/features/accounts/ipc", () => ({
  codexAccountUsage: (...args: unknown[]) => spies.codexUsage(...args),
  discoverAntigravityAccount: (...args: unknown[]) => spies.discoverAgy(...args),
  antigravityCliUsage: (...args: unknown[]) => spies.agyCli(...args),
  loadAccounts: vi.fn(async () => ({ accounts: [], systemAccounts: [] })),
}));

vi.mock("@/features/accounts/usage", async () => {
  const actual = await vi.importActual<typeof import("@/features/accounts/usage")>("@/features/accounts/usage");
  return {
    ...actual,
    claudeLiveUsage: (...args: unknown[]) => spies.claudeUsage(...args),
    agentAccountUsage: vi.fn(async () => ({ plan: { tier: null } })),
  };
});

vi.mock("@/features/missions/automation", () => ({
  ensureAutomation: () => () => {},
  hasPaused: () => false,
  resumeAutomation: vi.fn(),
  useAutomation: () => false,
}));
vi.mock("@/features/missions/vigiaSwitch", () => ({
  useVigiaSwitch: (sel: (s: { enabled: boolean; toggle: () => void }) => unknown) => sel({ enabled: false, toggle: vi.fn() }),
}));
vi.mock("@/features/missions/ScopeOverlapNotice", () => ({ MissionScopeOverlaps: () => null }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: () => null }));
vi.mock("@/shared/ui/ContextMenu", () => ({ ContextMenu: () => null }));
vi.mock("@/features/workspaces/useRepoInfo", () => ({ useRepoInfo: () => new Map() }));
vi.mock("@/features/terminal/terminalExcerpt", () => ({ appendToDraft: vi.fn() }));
vi.mock("@/features/terminal/safeWrite", () => ({ sendAutonomous: vi.fn() }));
vi.mock("../LazyChatMarkdown", () => ({ ChatMarkdown: ({ text }: { text: string }) => createElement("div", null, text) }));
vi.mock("../AIChatCard", () => ({ AIChatCard: () => null }));
vi.mock("../ResponsePicker", () => ({ ResponsePicker: () => null }));
vi.mock("../FloorBar", () => ({ FloorBar: () => null }));
vi.mock("../UsageBoard", () => ({ UsageBoard: () => null }));
vi.mock("../CanvasToolbar", () => ({ CanvasToolbar: () => null }));
vi.mock("../DrawingLayer", () => ({ DrawingLayer: () => null }));
vi.mock("../DeviceFloatBar", () => ({ DeviceFloatBar: () => null, PhoneModeIcon: () => null }));
vi.mock("../DeviceNode", () => ({ DeviceNode: () => null }));
vi.mock("../ExtraNodes", () => ({ ImageNode: () => null, TextNode: () => null }));
vi.mock("../FolderNode", () => ({ FolderNode: () => null, baseName: (p: string) => p }));
vi.mock("../ThreadNode", () => ({ ThreadNode: () => null }));
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
  isDesignNodeId: () => false,
}));
vi.mock("../design/useScopedDesigns", () => ({ useScopedDesigns: () => ({ details: [], boards: [], groups: [], empty: true }) }));
vi.mock("@/features/desktopApps/GeminiDesktopNode", () => ({ GeminiDesktopNode: () => null }));
vi.mock("@/features/simulator/SimulatorNode", () => ({ SimulatorNode: () => null }));
vi.mock("@/features/simulator/store", () => ({ refreshDevices: vi.fn(), useSimulatorStore: () => ({}) }));
vi.mock("@/shared/brand/Pet", () => ({ PetCard: () => null, usePetStatus: () => ({ idle: true, percent: 0 }) }));
vi.mock("@/features/peerQueue/PeerQueueBadge", () => ({ PeerQueueBadge: () => null }));
vi.mock("@/features/chat/team/TeamNodeBadge", () => ({ TeamNodeBadge: () => null }));
vi.mock("@/features/compare/ComparisonBar", () => ({ ComparisonBar: () => null }));
vi.mock("@/features/compare/store", () => ({ openCompareDialog: vi.fn() }));
vi.mock("@/features/missions/groups", () => ({ useMissionIndex: () => ({}) }));
vi.mock("../cliStatus", () => ({ useCliOutdatedNotice: () => null }));
vi.mock("../portalLifetime", () => ({ usePortalViewLifetime: () => {} }));
vi.mock("../routeSuggestion", () => ({ useRouteSuggestion: () => null, withTarget: (t: string) => t }));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  ConnectionMode: { Loose: "loose" },
  MiniMap: () => null,
  NodeResizer: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  ReactFlow: ({ nodes, nodeTypes }: { nodes: Array<{ id: string; type: string; data: unknown; selected?: boolean }>; nodeTypes: Record<string, React.ComponentType<Record<string, unknown>>> }) =>
    createElement(
      "div",
      { "data-testid": "rf" },
      nodes.map((n) => {
        const Comp = nodeTypes[n.type];
        return Comp ? createElement(Comp, { key: n.id, id: n.id, data: n.data, selected: Boolean(n.selected) }) : null;
      }),
    ),
  ReactFlowProvider: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  useNodesInitialized: () => false,
  useReactFlow: () => ({ setViewport: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 0.3 }) }),
}));

import { useUiStore } from "@/app/uiStore";
import { useAccountsStore } from "@/features/accounts/store";
import { useAgentActivity } from "@/features/terminal/activity";
import { useTabsStore } from "@/features/tabs/store";
import { useCanvasStore, setWorkMode } from "../store";
import { ChatPanel } from "../ChatPanel";
import { CanvasDock } from "../CanvasDock";
import { CanvasView } from "../CanvasView";
import { useTerminalPrompts } from "../useTerminalPrompts";
import { emptyBoard } from "../board";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let navFn: ((to: string) => void) | null = null;

function NavBridge({ children }: { children: ReactNode }) {
  navFn = useNavigate();
  return <>{children}</>;
}

const BOARD_KEY = "main|/proj#m:m1";

function setupStores(mode: "tabs" | "canvas") {
  const board = {
    ...emptyBoard(),
    viewport: { x: 0, y: 0, zoom: 0.3 },
    nodes: { t1: { x: 0, y: 0, w: 600, h: 400 } },
  };
  useTabsStore.setState({
    tabs: [{ id: "t1", title: "Agente 1 — /proj", cwd: "/proj", agentId: "codex", agentLabel: "Codex", command: "codex", ptyId: null, openedAt: 1 }],
    activeTabId: "t1",
  } as never);
  useCanvasStore.setState({
    boards: { [BOARD_KEY]: board },
    modes: { [BOARD_KEY]: mode },
    loaded: true,
    activeThread: null,
  });
  useUiStore.setState({ chatMode: true, shellMode: "workspace" });
  useAccountsStore.setState({
    loaded: true,
    systemAccounts: [],
    accounts: [{ id: "cx1", agentId: "codex", name: "Codex", loggedIn: true } as never],
  });
}

class FakeResizeObserver {
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    spies.roTrigger = cb;
  }
  observe(target: Element) { spies.roObserve(target); }
  disconnect() { spies.roDisconnect(); }
  unobserve() {}
  trigger() { this.cb(); }
}

beforeEach(() => {
  vi.useFakeTimers();
  spies.invoke.mockReset().mockImplementation(async (cmd: string) => (cmd === "chat_history" ? { currentThread: "blue", messages: [] } : []));
  spies.screenOf.mockReset().mockReturnValue({ lines: ["linha 1"] });
  spies.codexUsage.mockReset().mockImplementation(async () => ({ email: null, plan: null, auth: "chatgpt", quota: null, fetchedAt: Math.floor(Date.now() / 1000) }));
  spies.claudeUsage.mockReset().mockImplementation(async () => ({ available: true, session: null, week: null, weekModels: [], fetchedAt: Math.floor(Date.now() / 1000), cached: true, problem: null }));
  spies.discoverAgy.mockReset().mockImplementation(async () => ({ accountId: "ag", projectId: "p", inferenceVerified: false, fetchedAt: Math.floor(Date.now() / 1000), models: [] }));
  spies.agyCli.mockReset().mockResolvedValue({ installed: false, groups: [], fetchedAt: 0, cached: false });
  spies.roObserve.mockReset();
  spies.roDisconnect.mockReset();
  spies.roTrigger = null;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("canvas ocioso fora de vista", () => {
  it("ChatPanel pausa polls de 1,5 s (prompts) e 5 s (mensagens) no modo Abas, no Chat e fora de /workspace", async () => {
    setupStores("tabs");
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/workspace"]}>
          <NavBridge>
            <ChatPanel onClose={() => {}} onNewAgent={() => {}} />
          </NavBridge>
        </MemoryRouter>,
      );
    });

    // No modo Abas o canvas está escondido: os polls não devem rodar.
    spies.screenOf.mockClear();
    spies.invoke.mockClear();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(spies.screenOf).not.toHaveBeenCalled();
    expect(spies.invoke.mock.calls.filter(([cmd]) => cmd === "mission_messages")).toHaveLength(0);

    // Ao voltar para o canvas, ambos os polls retomam imediatamente.
    await act(async () => { setWorkMode(BOARD_KEY, "canvas"); });
    expect(spies.screenOf).toHaveBeenCalled();
    expect(spies.invoke.mock.calls.filter(([cmd]) => cmd === "mission_messages").length).toBeGreaterThan(0);

    // Com o modo Chat por cima, os polls pausam novamente.
    await act(async () => { useUiStore.setState({ shellMode: "chat" }); });
    spies.screenOf.mockClear();
    spies.invoke.mockClear();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(spies.screenOf).not.toHaveBeenCalled();
    expect(spies.invoke.mock.calls.filter(([cmd]) => cmd === "mission_messages")).toHaveLength(0);

    // Saindo do chat mas navegando fora de /workspace (/settings), continua ocioso.
    await act(async () => {
      useUiStore.setState({ shellMode: "workspace" });
      navFn?.("/settings");
    });
    spies.screenOf.mockClear();
    spies.invoke.mockClear();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(spies.screenOf).not.toHaveBeenCalled();
    expect(spies.invoke.mock.calls.filter(([cmd]) => cmd === "mission_messages")).toHaveLength(0);
  });

  it("useTerminalPrompts fora do canvas (PermissionsManager com enabled=true) continua ativo no modo Abas e Chat", async () => {
    setupStores("tabs");
    useUiStore.setState({ shellMode: "chat" });
    function OutsideProbe() {
      useTerminalPrompts([{ id: "t1", name: "Agente 1" }], true);
      return null;
    }
    await act(async () => { root.render(<OutsideProbe />); });
    spies.screenOf.mockClear();
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(spies.screenOf).toHaveBeenCalled();
  });

  it("CanvasDock pausa startUsagePolling quando canvas não está ativo e retoma imediatamente ao voltar", async () => {
    setupStores("tabs");
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/workspace"]}>
          <NavBridge>
            <CanvasDock zoom={1} panel={null} onTogglePanel={() => {}} onOpenChat={() => {}} onFit={() => {}} onReset={() => {}} petPercent={0} hasDesign={false} designUnseen={false} />
          </NavBridge>
        </MemoryRouter>,
      );
    });

    // No modo Abas não deve consultar uso.
    expect(spies.codexUsage).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000 + 100); });
    expect(spies.codexUsage).not.toHaveBeenCalled();

    // Voltando para o canvas em /workspace: leitura imediata.
    await act(async () => { setWorkMode(BOARD_KEY, "canvas"); });
    expect(spies.codexUsage).toHaveBeenCalledTimes(1);

    // Indo para /settings (fora de /workspace): pausa o intervalo de 5 min.
    await act(async () => { navFn?.("/settings"); });
    spies.codexUsage.mockClear();
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000 + 100); });
    expect(spies.codexUsage).not.toHaveBeenCalled();
  });

  it("CanvasView pausa Preview (useAgentActivity) e ResizeObserver quando canvas não está ativo", async () => {
    setupStores("tabs");
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/workspace"]}>
          <NavBridge>
            <CanvasView />
          </NavBridge>
        </MemoryRouter>,
      );
    });

    // Escondido: ResizeObserver não deve estar observando e atividade dos agentes não lê screenOf.
    expect(spies.roObserve).not.toHaveBeenCalled();
    spies.screenOf.mockClear();
    await act(async () => { useAgentActivity.setState({ working: true, count: 1 }); });
    expect(spies.screenOf).not.toHaveBeenCalled();

    // Ao ativar o canvas: observa wrapRef e Preview lê screenOf imediatamente e reage à atividade.
    await act(async () => { setWorkMode(BOARD_KEY, "canvas"); });
    expect(spies.roObserve).toHaveBeenCalled();
    expect(spies.screenOf).toHaveBeenCalled();

    // Ao abrir o Chat por cima: desconecta ResizeObserver e Preview para de assinar atividade.
    spies.roDisconnect.mockClear();
    await act(async () => { useUiStore.setState({ shellMode: "chat" }); });
    expect(spies.roDisconnect).toHaveBeenCalled();
    spies.screenOf.mockClear();
    await act(async () => { useAgentActivity.setState({ working: false, count: 0 }); });
    expect(spies.screenOf).not.toHaveBeenCalled();
  });
});
