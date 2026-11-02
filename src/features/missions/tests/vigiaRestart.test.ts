/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), send: vi.fn(), paused: false, noted: vi.fn(),
  listener: undefined as undefined | ((e: { payload: { kind: string; fromTabId: string; toTabId: string | null; text: string; atMs: number } }) => void),
}));
vi.mock("react", () => ({ useEffect: (effect: () => unknown) => effect() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (_event: string, listener: typeof mocks.listener) => { mocks.listener = listener; return Promise.resolve(() => {}); } }));
vi.mock("@/features/canvas/store", () => ({ useCanvasStore: { getState: () => ({ boards: { "repo#m:m": { orchestrators: ["lead"] } } }) }, boardKeyOfTab: () => "repo", conversationOfKey: () => null }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ tabs: [
  { id: "lead", title: "Orquestrador", agentId: "claude-code", cwd: "repo" },
  { id: "back", title: "Backend", agentId: "claude-code", cwd: "repo" },
], detectedAgents: [{ id: "claude-code", available: true }] }) } }));
vi.mock("../store", () => ({ useMissionsStore: { getState: () => ({ missions: [{ id: "m", status: "running", startedAt: (1_000_000 - 6 * 60_000) / 1000, title: "M" }] }) } }));
vi.mock("../groups", () => ({ missionIndex: () => ({}), tabsByMission: () => ({ m: ["lead", "back"] }) }));
vi.mock("../vigiaSwitch", () => ({ useVigiaSwitch: { getState: () => ({ enabled: true }) }, vigiaActive: () => true }));
vi.mock("../automation", () => ({ automationPausedFor: () => mocks.paused, notePausedTeam: mocks.noted }));
vi.mock("@/features/terminal/activity", () => ({ lastOutputAt: (id: string) => id === "lead" ? Date.now() : Date.now() - 91_000 }));
vi.mock("@/features/terminal/terminalRegistry", () => ({ screenOf: () => null, sendWhenReady: mocks.send }));
vi.mock("@/shared/brand/botToastStore", () => ({ showBotToast: vi.fn() }));

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const notices = () => mocks.invoke.mock.calls.filter(([command, args]) => command === "vigia_notify_user" && (args as { kind?: string })?.kind === "user_decision");

describe("Vigia depois de reabrir o app", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    localStorage.clear();
    mocks.paused = false;
    mocks.invoke.mockImplementation(() => Promise.resolve([]));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("com a missão armada antes do boot, não cutuca nem consulta o modelo até a pessoa retomar", async () => {
    mocks.paused = true;
    const { vigiaTick } = await import("../vigia");
    await vigiaTick();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "vigia_check")).toHaveLength(0);
    expect(mocks.noted).toHaveBeenCalledWith("m", "M");
    mocks.paused = false;
    void vigiaTick();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("o \"Decisão pendente\" da mesma rodada não se repete ao reabrir", async () => {
    mocks.invoke.mockImplementation((command: string) => Promise.resolve(command === "vigia_check" ? [{ to: "usuario", message: "Pode apagar as imagens?" }] : []));
    const first = await import("../vigia");
    first.useVigiaDriver();
    mocks.listener?.({ payload: { kind: "tell", fromTabId: "lead", toTabId: "back", text: "Rode os testes.", atMs: 1_000_000 - 100_000 } });
    await first.vigiaTick();
    await flush();
    expect(notices()).toHaveLength(1);
    // Reabrir: módulos novos, o localStorage fica.
    vi.resetModules();
    vi.setSystemTime(1_000_000 + first.VIGIA_COOLDOWN_MS + 1);
    const second = await import("../vigia");
    await second.vigiaTick();
    await flush();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "vigia_check")).toHaveLength(2);
    expect(notices()).toHaveLength(1);
  });
});
