// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  handlers: {} as Record<string, ((e: { payload: unknown }) => void)[]>,
  workingDiffCalls: [] as string[],
  workingDiffStatCalls: [] as string[],
  workingDiffStatResult: { root: "/repo", added: 12, removed: 4 } as { root: string; added: number; removed: number } | null,
  rowRenders: {} as Record<string, number>,
  sidebarMounts: { app: 0, chat: 0 },
  receivedGroups: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { cwd?: string }) => {
    if (cmd === "scm_working_diff_stat") {
      spies.workingDiffStatCalls.push(args?.cwd ?? "");
      return Promise.resolve(spies.workingDiffStatResult);
    }
    if (cmd === "scm_working_diff") {
      spies.workingDiffCalls.push(args?.cwd ?? "");
      return Promise.resolve(null);
    }
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    (spies.handlers[name] ??= []).push(handler);
    return Promise.resolve(() => {
      const list = spies.handlers[name];
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    });
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => undefined),
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));
vi.mock("@/features/chat/team/TeamSidebar", () => ({
  TeamBadge: ({ convKey }: { convKey: string }) => {
    spies.rowRenders[convKey] = (spies.rowRenders[convKey] ?? 0) + 1;
    return null;
  },
  TeamMembers: () => null,
  conversationDragProps: () => ({ draggable: true, onDragStart: () => undefined }),
  useTeamGrouping: () => ({ nested: new Set<string>(), groups: {} }),
}));

// Mocks leves dos subsistemas do AppShell para medir contagem de sidebars montadas e estabilidade de `groups`.
vi.mock("@/features/tabs/EditorArea", () => ({ EditorArea: () => <div data-testid="editor-area" /> }));
vi.mock("@/features/tabs/TabBar", () => ({ TabBar: () => <div data-testid="tab-bar" /> }));
vi.mock("@/features/sidePanel/PanelButtons", () => ({ PanelButtons: () => null }));
vi.mock("@/app/SideHead", () => ({ SideHead: () => null }));
vi.mock("@/app/ActivityRail", () => ({ ActivityRail: () => null, RAIL_COMPACT_W: 48, RAIL_EXPANDED_W: 212 }));
vi.mock("@/app/StatusBarRegion", () => ({ StatusBarRegion: () => null }));
vi.mock("@/app/ResizeHandles", () => ({ ResizeHandles: () => null }));
vi.mock("@/app/AppExitListener", () => ({ AppExitListener: () => null }));
vi.mock("@/app/useGlobalShortcuts", () => ({ useGlobalShortcuts: () => undefined }));
vi.mock("@/app/afterFirstFrame", () => ({ restoreDeferredWindowsAfterFirstFrame: () => undefined }));
vi.mock("@/app/splash", () => ({ followAppBoot: () => Promise.resolve() }));
vi.mock("@/features/tabs/persistence", () => ({ initTabsPersistence: () => undefined, waitForHydration: () => Promise.resolve() }));
vi.mock("@/features/tabs/layout/layoutStore", () => ({ initLayoutSync: () => undefined }));
vi.mock("@/features/tabs/viewStore", () => ({ initViewTabsPersistence: () => undefined }));
vi.mock("@/features/canvas/store", () => ({ boardKeyOfTab: () => "k", initCanvasSync: () => undefined, setWorkMode: () => undefined, useWorkMode: () => "tabs" }));
vi.mock("@/features/canvas/orchestratorAnnounce", () => ({ initOrchestratorAnnouncements: () => undefined }));
vi.mock("@/features/chat/unified/selectionActions", () => ({ selectConversation: () => undefined, startSelectionSync: () => () => undefined }));
vi.mock("@/features/sessions/useSessionCheckpoints", () => ({ useSessionCheckpoints: () => undefined }));
vi.mock("@/features/tabCheckpoints/useTabCheckpointsCapture", () => ({ useTabCheckpointsCapture: () => undefined }));
vi.mock("@/features/terminal/useFileDropToTerminal", () => ({ useFileDropToTerminal: () => undefined }));
vi.mock("@/features/sync/SyncRunner", () => ({ SyncRunner: () => null }));
vi.mock("@/features/memorySync/MemorySyncRunner", () => ({ MemorySyncRunner: () => null }));
vi.mock("@/features/updates/UpdateNotifier", () => ({ UpdateNotifier: () => null }));
vi.mock("@/features/runs/ApprovalToast", () => ({ ApprovalToast: () => null }));
vi.mock("@/features/browser/CaptchaHandoffCard", () => ({ CaptchaHandoffCard: () => null }));
vi.mock("@/features/chat/InAppNotices", () => ({ InAppNotices: () => null }));
vi.mock("@/features/accounts/PoolFailoverNotice", () => ({ PoolFailoverNotice: () => null }));
vi.mock("@/features/agents/AgentUpdateWatcher", () => ({ AgentUpdateWatcher: () => null }));
vi.mock("@/shared/brand/BotToastHost", () => ({ BotToastHost: () => null }));
vi.mock("@/shared/ui/AppConfirmHost", () => ({ AppConfirmHost: () => null }));
vi.mock("@/features/bot/LazyBotPanel", () => ({ BotPanel: () => null }));
vi.mock("@/features/orchestrator/cliBridge", () => ({ initCliBridge: () => () => undefined }));
vi.mock("@/features/runs/useFleetEvents", () => ({ useFleetEvents: () => undefined }));
vi.mock("@/features/agents/ipc", () => ({
  detectAgents: () => Promise.resolve([]),
  listCustomAgents: () => Promise.resolve([]),
}));
vi.mock("@/features/tabs/ipc", () => ({ loadWindowState: () => Promise.resolve(null) }));
vi.mock("@/features/workspaces/useRepoInfo", () => {
  const empty = new Map();
  return { useRepoInfo: () => empty };
});
vi.mock("@/features/sidePanel/SessionPanel", () => ({ SessionPanel: () => null }));
vi.mock("@/features/workspaces/snapshotsStore", () => {
  const state = { snapshots: [] as never[], load: () => Promise.resolve() };
  return {
    useSnapshotsStore: (sel: (s: typeof state) => unknown) => sel(state),
  };
});
vi.mock("@/features/chat/NewConversation", () => ({ NewConversation: () => null, pickProjectFolder: () => Promise.resolve(null) }));
vi.mock("@/features/chat/sidebar/AppSessionsSidebar", () => ({
  AppSessionsSidebar: ({ groups }: { groups: unknown }) => {
    spies.receivedGroups.push(groups);
    useEffect(() => {
      spies.sidebarMounts.app += 1;
      return () => { spies.sidebarMounts.app -= 1; };
    }, []);
    return <aside data-sidebar-kind="app" />;
  },
}));
vi.mock("@/features/chat/ChatShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ChatShell")>();
  return {
    ...actual,
    ChatShell: ({ groups }: { groups: unknown }) => {
      spies.receivedGroups.push(groups);
      useEffect(() => {
        spies.sidebarMounts.chat += 1;
        return () => { spies.sidebarMounts.chat -= 1; };
      }, []);
      return <aside data-sidebar-kind="chat" />;
    },
  };
});

import { AppShell } from "@/app/AppShell";
import { useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import type { ConversationCard } from "../chatModel";
import { ChatSidebar, type FolderDiff } from "../ChatSidebar";
import { useFolderDiffs } from "../ChatShell";
import { useShelf } from "../shelf";
import { buildSidebarCards } from "../sidebar/useSidebarCards";
import { startStructured, useStructured } from "../structured/store";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

const emit = (name: string, payload: unknown) => {
  for (const h of [...(spies.handlers[name] ?? [])]) h({ payload });
};

const makeCard = (id: string, title: string, cwd = "/repo"): ConversationCard => ({
  tabId: id,
  title,
  project: cwd.split("/").pop() ?? "repo",
  cwd,
  branch: "main",
  isWorktree: false,
  agentId: "claude-code",
  agentLabel: "Claude Code",
  starting: false,
  active: false,
  openedAt: 10,
});

const makeTab = (id: string, cwd = "/repo"): Tab => ({
  id,
  title: `Aba ${id}`,
  cwd,
  agentId: "claude-code",
  agentLabel: "Claude Code",
  command: "claude",
  ptyId: 1,
  openedAt: 10,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  spies.handlers = {};
  spies.workingDiffCalls = [];
  spies.workingDiffStatCalls = [];
  spies.workingDiffStatResult = { root: "/repo", added: 12, removed: 4 };
  spies.rowRenders = {};
  spies.sidebarMounts = { app: 0, chat: 0 };
  spies.receivedGroups = [];
  useUiStore.setState({ chatMode: true, shellMode: "chat", workspacesCollapsed: false });
  useTabsStore.setState({ tabs: [makeTab("t1"), makeTab("t2")], activeTabId: "t1", hydrated: true });
  useShelf.setState({ snoozed: [], settled: [], pinned: [], unread: [], collapsed: [] });
  useStructured.setState({ threads: [], live: {}, goals: {}, goalNotices: {}, hydrated: {}, hydrateErrors: {}, logFailures: {}, lastItemAt: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PR-F · sidebar única montada no AppShell (F-R5 e F-R11)", () => {
  it("monta exatamente 1 sidebar de conversas no modo chat e ao alternar para workspace", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/workspace"]}>
          <AppShell />
        </MemoryRouter>,
      );
    });
    // Aguarda os lazy imports resolverem.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(spies.sidebarMounts.chat).toBe(1);
    expect(spies.sidebarMounts.app).toBe(0);
    expect(host.querySelectorAll("[data-sidebar-kind]").length).toBe(1);

    // Alternar para workspace desmonta ChatShell e monta apenas AppSessionsSidebar.
    await act(async () => { useUiStore.setState({ shellMode: "workspace" }); });
    await act(async () => { await Promise.resolve(); });
    expect(spies.sidebarMounts.chat).toBe(0);
    expect(spies.sidebarMounts.app).toBe(1);
    expect(host.querySelectorAll("[data-sidebar-kind]").length).toBe(1);

    // Voltar para chat desmonta AppSessionsSidebar e monta apenas ChatShell.
    await act(async () => { useUiStore.setState({ shellMode: "chat" }); });
    await act(async () => { await Promise.resolve(); });
    expect(spies.sidebarMounts.chat).toBe(1);
    expect(spies.sidebarMounts.app).toBe(0);
    expect(host.querySelectorAll("[data-sidebar-kind]").length).toBe(1);
  });

  it("trocar de aba ativa não reconstrói groups no AppShell (F-R11)", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/workspace"]}>
          <AppShell />
        </MemoryRouter>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    const firstGroups = spies.receivedGroups[spies.receivedGroups.length - 1];
    expect(firstGroups).toBeDefined();

    await act(async () => { useTabsStore.setState({ activeTabId: "t2" }); });
    const nextGroups = spies.receivedGroups[spies.receivedGroups.length - 1];
    expect(nextGroups).toBe(firstGroups);
  });
});

describe("PR-F · totais de diff via --numstat sem reler o diff completo (F-R5)", () => {
  it("useFolderDiffs lê 1x por pasta via scm_working_diff_stat e nunca chama scm_working_diff", async () => {
    vi.useFakeTimers();
    const cards = [makeCard("a", "Conv A", "/repo"), makeCard("b", "Conv B", "/repo")];
    let latest: Record<string, FolderDiff> = {};
    function Probe() {
      latest = useFolderDiffs(cards);
      return null;
    }

    await act(async () => { root.render(<Probe />); });
    expect(spies.workingDiffStatCalls).toEqual(["/repo"]);
    expect(spies.workingDiffCalls).toEqual([]);
    expect(latest["/repo"]).toEqual({ added: 12, removed: 4 });
    const prevRef = latest["/repo"];

    spies.workingDiffStatCalls = [];
    await act(async () => { emit("cc-conversation-grew", { tabId: "a" }); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(spies.workingDiffStatCalls).toEqual(["/repo"]);
    expect(spies.workingDiffCalls).toEqual([]);
    // Mesmos números: preserva a referência do objeto para não invalidar SessionRow.
    expect(latest["/repo"]).toBe(prevRef);
  });
});

describe("PR-F · linhas memoizadas, dedup de cards e threads estável em eventos de item (F-R6)", () => {
  it("evento item do protocolo não troca o array threads e registra lastItemAt (F-R6)", async () => {
    const initialThreads = [
      { id: "th1", agentId: "claude-code", cwd: "/repo", title: "T1", model: null, effort: null, access: "ask" as const, accountId: null, state: "active" as const, createdAt: 1, updatedAt: 10 },
      { id: "th2", agentId: "codex", cwd: "/repo", title: "T2", model: null, effort: null, access: "ask" as const, accountId: null, state: "active" as const, createdAt: 1, updatedAt: 5 },
    ];
    useStructured.setState({ threads: initialThreads, lastItemAt: {} });
    startStructured();
    await act(async () => { await Promise.resolve(); });

    const before = useStructured.getState().threads;
    await act(async () => {
      emit("cc-chat-thread", { type: "item", threadId: "th1", item: { kind: "assistant", id: "m1", text: "ok" } });
    });

    expect(useStructured.getState().threads).toBe(before);
    expect(useStructured.getState().live.th1?.items).toHaveLength(1);
    expect(useStructured.getState().lastItemAt.th1).toBeGreaterThan(0);
  });

  it("buildSidebarCards reaproveita referências dos cartões inalterados", () => {
    const group = (titleA: string): RepoGroup[] => [{
      key: "/repo",
      name: "repo",
      isRepo: true,
      agentCount: 2,
      workspaces: [{
        key: "/repo",
        cwd: "/repo",
        title: "repo",
        branch: "main",
        isPrimary: true,
        isWorktree: false,
        changedCount: 0,
        closed: false,
        savedAgents: 0,
        agents: [
          { tabId: "a", title: titleA, agentId: "claude-code", agentLabel: "Claude Code", status: "running", isActive: false, openedAt: 20 },
          { tabId: "b", title: "Conversa B", agentId: "codex", agentLabel: "Codex", status: "running", isActive: false, openedAt: 10 },
        ],
      }],
    }];
    const first = buildSidebarCards(group("Conversa A"), [], [], [], "separate");
    const prev = new Map(first.map((c) => [c.tabId, c]));
    const second = buildSidebarCards(group("Conversa A editada"), [], [], [], "separate", prev);
    expect(second.find((c) => c.tabId === "a")).not.toBe(prev.get("a"));
    expect(second.find((c) => c.tabId === "b")).toBe(prev.get("b"));
  });

  it("trocar seleção ou título de uma conversa não re-renderiza linhas de outras conversas", async () => {
    const a = makeCard("a", "Conversa A", "/repo-a");
    const b = makeCard("b", "Conversa B", "/repo-b");
    const c = makeCard("c", "Conversa C", "/repo-c");
    const diffs: Record<string, FolderDiff> = { "/repo-a": { added: 1, removed: 0 } };
    const noop = () => undefined;

    const renderSidebar = (cards: ConversationCard[], selectedId: string) =>
      act(async () => {
        root.render(
          <MemoryRouter>
            <ChatSidebar cards={cards} closed={[]} diffs={diffs} selectedId={selectedId}
              onCollapse={noop} onAddProject={noop} onReopen={noop} />
          </MemoryRouter>,
        );
      });

    await renderSidebar([a, b, c], "a");
    expect(spies.rowRenders.a).toBeGreaterThanOrEqual(1);
    expect(spies.rowRenders.b).toBeGreaterThanOrEqual(1);
    expect(spies.rowRenders.c).toBeGreaterThanOrEqual(1);

    // 1) Troca de seleção de "a" para "b": só "a" e "b" mudam; "c" não re-renderiza.
    spies.rowRenders = {};
    await renderSidebar([a, b, c], "b");
    expect(spies.rowRenders.a ?? 0).toBe(1);
    expect(spies.rowRenders.b ?? 0).toBe(1);
    expect(spies.rowRenders.c ?? 0).toBe(0);

    // 2) Muda o título só de "a" (mantendo referência de "b" e "c"): só "a" re-renderiza.
    spies.rowRenders = {};
    const aRenamed = { ...a, title: "Conversa A editada" };
    await renderSidebar([aRenamed, b, c], "b");
    expect(spies.rowRenders.a ?? 0).toBe(1);
    expect(spies.rowRenders.b ?? 0).toBe(0);
    expect(spies.rowRenders.c ?? 0).toBe(0);
  });
});
