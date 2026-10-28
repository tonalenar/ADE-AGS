/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_DORMANT_MS, conversationWatchable, freshEntries, userDecisionAllowed } from "../vigiaConversation";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), send: vi.fn(), listener: undefined as undefined | ((e: { payload: { kind: string; fromTabId: string; toTabId: string | null; text: string; atMs: number } }) => void),
  state: "active" as "active" | "saved",
  idleSince: 91_000,
}));
vi.mock("react", () => ({ useEffect: (effect: () => unknown) => effect() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (_event: string, listener: typeof mocks.listener) => { mocks.listener = listener; return Promise.resolve(() => {}); } }));
vi.mock("@/features/canvas/store", () => ({
  useCanvasStore: { getState: () => ({ boards: { "w|repo#c:conv1": { orchestrators: ["lead"], edges: [], nodes: {} } } }) },
  boardKeyOfTab: () => "w|repo#c:conv1",
  conversationOfKey: (key: string | null) => key?.split("#c:")[1] ?? null,
}));
vi.mock("@/features/canvas/orchestratorNotice", () => ({ linkedPeers: () => ["back"] }));
vi.mock("@/features/sessions/conversationsStore", () => ({ useConversationsStore: { getState: () => ({ rows: [
  { id: "conv1", workspaceId: "w", projectKey: "repo", cwd: "repo", title: "Mover imagens", customTitle: null, pinned: false, hidden: false, state: mocks.state, terminals: [], createdAt: 0, lastActiveAt: 0 },
] }) } }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ tabs: [
  { id: "lead", title: "Claude Code", agentId: "claude-code", cwd: "repo" },
  { id: "back", title: "Backend", agentId: "claude-code", cwd: "repo" },
], detectedAgents: [{ id: "claude-code", available: true }] }) } }));
vi.mock("../store", () => ({ useMissionsStore: { getState: () => ({ missions: [] }) } }));
vi.mock("../groups", () => ({ missionIndex: () => ({}), tabsByMission: () => ({}) }));
vi.mock("../vigiaSwitch", () => ({ useVigiaSwitch: { getState: () => ({ enabled: true }) }, vigiaActive: () => true }));
vi.mock("@/features/terminal/activity", () => ({ lastOutputAt: () => Date.now() - mocks.idleSince }));
vi.mock("@/features/terminal/terminalRegistry", () => ({ screenOf: () => null, sendWhenReady: mocks.send }));
vi.mock("@/shared/brand/botToastStore", () => ({ showBotToast: vi.fn() }));

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const peer = (fromTabId: string, toTabId: string | null, text: string, atMs = Date.now()) =>
  mocks.listener?.({ payload: { kind: "tell", fromTabId, toTabId, text, atMs } });
const commands = () => mocks.invoke.mock.calls.map(([command]) => command);

describe("conversationWatchable", () => {
  const now = 10 * CONVERSATION_DORMANT_MS;

  it("corda sem tarefa não é time", () => {
    expect(conversationWatchable({ now, state: "active", taskTimes: [], activity: [now] })).toBe(false);
  });

  it("conversa guardada (o usuário abriu outra) não é vigiada", () => {
    expect(conversationWatchable({ now, state: "saved", taskTimes: [now], activity: [now] })).toBe(false);
  });

  it("dorme depois de um tempo sem tarefa, mensagem nem saída; acorda com tarefa nova", () => {
    const old = now - CONVERSATION_DORMANT_MS;
    expect(conversationWatchable({ now, state: "active", taskTimes: [old], activity: [old, undefined] })).toBe(false);
    expect(conversationWatchable({ now, state: "active", taskTimes: [old], activity: [now - 60_000] })).toBe(true);
    expect(conversationWatchable({ now, state: null, taskTimes: [now - 1000], activity: [] })).toBe(true);
  });
});

describe("userDecisionAllowed", () => {
  it("numa conversa nunca vira aviso do sistema", () => {
    expect(userDecisionAllowed("conversation", undefined, 5)).toBe(false);
  });

  it("numa missão, um por rodada de tarefas", () => {
    expect(userDecisionAllowed("mission", undefined, undefined)).toBe(true);
    expect(userDecisionAllowed("mission", 5, 5)).toBe(false);
    expect(userDecisionAllowed("mission", 5, 9)).toBe(true);
    expect(userDecisionAllowed("mission", 0, undefined)).toBe(false);
  });
});

describe("freshEntries", () => {
  it("descarta as antigas e as inválidas", () => {
    const kept = freshEntries({ a: 100, b: 10, c: Number.NaN }, 50);
    expect([...kept.keys()]).toEqual(["a"]);
    expect(freshEntries(undefined, 0).size).toBe(0);
  });
});

describe("Vigia numa conversa de projeto", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(100 * 60_000);
    localStorage.clear();
    mocks.state = "active";
    mocks.idleSince = 91_000;
    mocks.invoke.mockImplementation(() => Promise.resolve([]));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("terminal ligado por corda sem tarefa: o Vigia não olha a conversa", async () => {
    const { vigiaTick } = await import("../vigia");
    await vigiaTick();
    expect(commands()).not.toContain("vigia_check");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("com tarefa delegada, consulta o modelo só pelo integrante (o Orquestrador espera o usuário)", async () => {
    mocks.invoke.mockImplementation((command: string) => Promise.resolve(command === "vigia_check" ? [{ to: "usuario", message: "Pode apagar as imagens?" }] : []));
    const { useVigiaDriver, vigiaTick } = await import("../vigia");
    useVigiaDriver();
    peer("lead", "back", "Mova as imagens da pasta LVR.");
    await vigiaTick();
    await flush();
    const check = mocks.invoke.mock.calls.find(([command]) => command === "vigia_check");
    expect(check?.[1].idle).toEqual([{ tabId: "back", name: "Backend" }]);
    expect(check?.[1].missionTitle).toBe("Mover imagens");
    // "Decisão pendente" de conversa fica só no chat, sem aviso do sistema.
    expect(commands()).not.toContain("vigia_notify_user");
    expect(commands()).toContain("vigia_report");
  });

  it("conversa guardada ou dormente: nada", async () => {
    const { useVigiaDriver, vigiaTick } = await import("../vigia");
    useVigiaDriver();
    peer("lead", "back", "Mova as imagens.", Date.now() - CONVERSATION_DORMANT_MS - 60_000);
    mocks.idleSince = CONVERSATION_DORMANT_MS + 60_000;
    await vigiaTick();
    expect(commands()).not.toContain("vigia_check");

    mocks.idleSince = 91_000;
    mocks.state = "saved";
    peer("lead", "back", "Outra tarefa.");
    await vigiaTick();
    expect(commands()).not.toContain("vigia_check");
  });
});
