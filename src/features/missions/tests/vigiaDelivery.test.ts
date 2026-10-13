/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), send: vi.fn(), listener: undefined as undefined | ((e: { payload: { kind: string; fromTabId: string; toTabId: string | null; text: string; atMs: number } }) => void),
  startedAt: 1000,
}));
vi.mock("react", () => ({ useEffect: (effect: () => unknown) => effect() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (_event: string, listener: typeof mocks.listener) => { mocks.listener = listener; return Promise.resolve(() => {}); } }));
vi.mock("@/features/canvas/store", () => ({ useCanvasStore: { getState: () => ({ boards: { "repo#m:m": { orchestrators: ["lead"] } } }) } }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({ tabs: [
  { id: "lead", title: "Orquestrador", agentId: "claude-code", cwd: "repo" },
  { id: "back", title: "Backend", agentId: "claude-code", cwd: "repo" },
], detectedAgents: [{ id: "claude-code", available: true }] }) } }));
vi.mock("../store", () => ({ useMissionsStore: { getState: () => ({ missions: [{ id: "m", status: "running", startedAt: mocks.startedAt, title: "M" }] }) } }));
vi.mock("../groups", () => ({ missionIndex: () => ({}), tabsByMission: () => ({ m: ["lead", "back"] }) }));
vi.mock("../vigiaSwitch", () => ({ useVigiaSwitch: { getState: () => ({ enabled: true }) } }));
vi.mock("@/features/terminal/activity", () => ({ lastOutputAt: (id: string) => id === "lead" ? Date.now() : Date.now() - 91_000 }));
vi.mock("@/features/terminal/terminalRegistry", () => ({ screenOf: () => null, sendWhenReady: mocks.send }));
vi.mock("@/shared/brand/botToastStore", () => ({ showBotToast: vi.fn() }));

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const peer = (fromTabId: string, toTabId: string | null, text: string, kind = "tell", atMs = Date.now()) =>
  mocks.listener?.({ payload: { kind, fromTabId, toTabId, text, atMs } });

describe("Vigia: entrega final e confirmação de envio", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    localStorage.clear();
    mocks.startedAt = 1000;
    mocks.invoke.mockImplementation(() => Promise.resolve([]));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("status não tira o integrante da observação, entrega final tira", async () => {
    const { useVigiaDriver, vigiaTick } = await import("../vigia");
    useVigiaDriver();
    peer("lead", "back", "Rode os testes.", "tell", Date.now() - 100_000);
    peer("back", "lead", "Backend iniciou: testes em execução.", "tell", Date.now() - 1000);
    vigiaTick();
    expect(mocks.invoke).toHaveBeenCalledWith("vigia_check", expect.objectContaining({ idle: [{ tabId: "back", name: "Backend" }] }));
    await flush();
    mocks.invoke.mockClear();
    peer("back", "lead", "BACKEND ENTREGUE. Commit abc.");
    vigiaTick();
    expect(mocks.invoke).not.toHaveBeenCalled();
    // Só o Orquestrador passa tarefa: a mensagem do integrante a ele não vira "tarefa" do Orquestrador.
    expect(JSON.parse(localStorage.getItem("ags.vigia.peers.v1")!).task.lead).toBeUndefined();
    peer("lead", "back", "Rode a próxima tarefa.", "tell", Date.now() + 1);
    const { VIGIA_COOLDOWN_MS } = await import("../vigia");
    vi.setSystemTime(Date.now() + VIGIA_COOLDOWN_MS + 1);
    vigiaTick();
    expect(mocks.invoke).toHaveBeenCalledWith("vigia_check", expect.objectContaining({ idle: [{ tabId: "back", name: "Backend" }] }));
    await flush();
  });

  it("não cutuca quem entregou durante a consulta assíncrona", async () => {
    let resolve!: (actions: { to: string; message: string }[]) => void;
    mocks.invoke.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { useVigiaDriver, vigiaTick } = await import("../vigia");
    useVigiaDriver();
    peer("lead", "back", "Rode os testes.", "tell", Date.now() - 100_000);
    vigiaTick();
    peer("back", "lead", "BACKEND ENTREGUE.");
    resolve([{ to: "Backend", message: "Reporte o resultado." }]);
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fila sem terminal não registra mandei; só onSent confirma", async () => {
    mocks.invoke.mockResolvedValue([{ to: "Backend", message: "Reporte o resultado." }]);
    const { vigiaTick } = await import("../vigia");
    vigiaTick();
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "vigia_report")).toHaveLength(0);
    const timing = mocks.send.mock.calls[0][2];
    timing.onSent(Date.now() + 45_000);
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("vigia_report", expect.objectContaining({ text: expect.stringContaining("mandei a Backend.") }));
  });

  it("watchdog também espera onSent antes de contar e registrar o lembrete", async () => {
    mocks.startedAt = (Date.now() - 6 * 60_000) / 1000;
    const { vigiaTick } = await import("../vigia");
    vigiaTick();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.send.mock.calls[0][2].onSent(Date.now());
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("vigia_report", expect.objectContaining({ text: expect.stringContaining("lembrete 1/3 enviado") }));
  });

  it("falha de persistência do aviso fica visível no console", async () => {
    const error = new Error("falha de registro de teste");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invoke.mockImplementation((command: string) => command === "vigia_report"
      ? Promise.reject(error) : Promise.resolve([{ to: "usuario", message: "Decida a proposta." }]));
    const { vigiaTick } = await import("../vigia");
    vigiaTick();
    await flush();
    expect(log).toHaveBeenCalledWith("[Vigia] não foi possível registrar o aviso", error);
  });
});

describe("Vigia: conversa entre integrantes não reabre a tarefa de quem entregou", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    localStorage.clear();
    mocks.startedAt = 1000;
    mocks.invoke.mockImplementation(() => Promise.resolve([]));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("o 'excelente, obrigado' de outro integrante depois da entrega não vira tarefa nova", async () => {
    const { useVigiaDriver } = await import("../vigia");
    useVigiaDriver();
    peer("lead", "back", "Rode os testes.", "tell", 1_000_000 - 100_000);
    peer("back", "lead", "Backend: corrigi A1 em src-tauri/src/memory.rs, commit 4f1a2b3, ags test run rust verde (1378 passaram), sem pendências.", "tell", 1_000_000 - 50_000);
    peer("qa", "back", "Excelente! Entrega confirmada e registrada no relatório de QA, obrigado pela rapidez.", "tell", 1_000_000 - 10_000);
    const saved = JSON.parse(localStorage.getItem("ags.vigia.peers.v1")!);
    expect(saved.task.back).toBe(1_000_000 - 100_000);
    expect(saved.finished.back).toBe(1_000_000 - 50_000);
    expect(saved.finished.back).toBeGreaterThanOrEqual(saved.task.back);
  });
});
