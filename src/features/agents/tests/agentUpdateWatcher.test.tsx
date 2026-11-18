/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  lang: { current: "pt-BR" },
  setDetectedAgents: vi.fn(),
  checks: vi.fn(),
  agentUpdate: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  // Um `t` novo a cada render, como o real quando o idioma muda: o efeito não pode depender dele (A174).
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => `${mocks.lang.current}|${key} ${JSON.stringify(opts ?? {})}`,
  }),
}));
vi.mock("@/shared/brand/botToastStore", () => ({
  showBotToast: vi.fn(() => 1),
  useBotToastStore: { getState: () => ({ push: vi.fn(() => 1), update: vi.fn(), dismiss: vi.fn() }) },
}));
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: Object.assign(
    (selector: (s: { setDetectedAgents: unknown }) => unknown) => selector({ setDetectedAgents: mocks.setDetectedAgents }),
    { getState: () => ({ tabs: [], setDetectedAgents: mocks.setDetectedAgents, restartAgent: vi.fn() }) },
  ),
}));
vi.mock("@/shared/ipc/settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/features/terminal/ipc", () => ({ ptyForTab: vi.fn(), ptyKill: vi.fn() }));
vi.mock("@/app/closeWithSave", () => ({ exitAllWithSave: vi.fn() }));
vi.mock("../ipc", () => ({
  agentUpdate: mocks.agentUpdate,
  agentUpdatesCheck: mocks.checks,
  agentUpdateWorkRunning: vi.fn(() => Promise.resolve(false)),
  detectAgents: vi.fn(() => Promise.resolve([])),
}));

import { showBotToast } from "@/shared/brand/botToastStore";

import { AgentUpdateWatcher } from "../AgentUpdateWatcher";
import { FIRST_AGENT_CHECK_MS } from "../updatePolicy";

const info = {
  agentId: "codex", label: "Codex", currentVersion: "0.1.0", latestVersion: "0.2.0",
  updateAvailable: true, canAutoUpdate: true, busy: false, reason: null,
};

let host: HTMLDivElement;
let root: Root;

function renderWatcher() {
  act(() => { root.render(<AgentUpdateWatcher />); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.lang.current = "pt-BR";
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe("AgentUpdateWatcher: a falha da atualização automática aparece (A173)", () => {
  it("uma falha de IPC na atualização automática mostra a causa para a pessoa", async () => {
    mocks.checks.mockResolvedValue([info]);
    mocks.getSetting.mockResolvedValue("true");
    mocks.agentUpdate.mockRejectedValue(new Error("disco cheio"));
    vi.mocked(showBotToast).mockClear();
    renderWatcher();
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_AGENT_CHECK_MS + 10); });
    expect(showBotToast).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("disco cheio"),
    }));
  });
});

describe("AgentUpdateWatcher: trocar o idioma não repete o aviso (A174)", () => {
  it("o aviso de atualização disponível não volta a aparecer quando o idioma muda", async () => {
    mocks.checks.mockResolvedValue([{ ...info, canAutoUpdate: false }]);
    mocks.getSetting.mockResolvedValue("false");
    vi.mocked(showBotToast).mockClear();
    const countAvailable = () => vi.mocked(showBotToast).mock.calls.filter(([arg]) => String(arg.text).includes("agents.update.available")).length;

    renderWatcher();
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_AGENT_CHECK_MS + 10); });
    expect(countAvailable()).toBe(1);

    mocks.lang.current = "en";
    renderWatcher();
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_AGENT_CHECK_MS + 10); });
    expect(countAvailable()).toBe(1);
  });
});
