/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  tabContextUsage: vi.fn(),
  forgePulls: vi.fn(),
  forgePullFiles: vi.fn(),
  getTimings: vi.fn(),
  getMissionEfficiency: vi.fn(),
  getTokens: vi.fn(),
  missionBudget: vi.fn(),
  planLimits: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/features/tabs/panelIpc", () => ({
  tabContextUsage: mocks.tabContextUsage,
  tabConnectors: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/features/forge/ipc", () => ({
  forgePulls: mocks.forgePulls,
  forgePullFiles: mocks.forgePullFiles,
}));
vi.mock("@/features/missions/timings", async () => {
  const actual = await vi.importActual<typeof import("@/features/missions/timings")>("@/features/missions/timings");
  return {
    ...actual,
    getTimings: mocks.getTimings,
    getMissionEfficiency: mocks.getMissionEfficiency,
  };
});
vi.mock("@/features/missions/tokens", async () => {
  const actual = await vi.importActual<typeof import("@/features/missions/tokens")>("@/features/missions/tokens");
  return {
    ...actual,
    getTokens: mocks.getTokens,
  };
});
vi.mock("@/features/missions/budgetIpc", () => ({
  missionBudget: mocks.missionBudget,
  planLimits: mocks.planLimits,
}));

import { ContextSection } from "../AgentSections";
import { usePulls } from "../SessionPanel";
import { MissionTimingsPanel } from "@/features/missions/MissionTimingsPanel";
import { MissionTokensPanel } from "@/features/missions/MissionTokensPanel";
import { BudgetBar } from "@/features/missions/BudgetBar";
import { PlanLimitsPanel } from "@/features/missions/PlanLimitsPanel";
import type { Tab } from "@/features/tabs/types";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

const fakeTab: Tab = {
  id: "t1",
  title: "Claude",
  agentId: "claude-code",
  agentLabel: "Claude Code",
  command: "claude",
  ptyId: null,
  cwd: "/repo",
  sessionId: "sess-1",
  openedAt: 1,
};

function PullsProbe() {
  usePulls("/repo", "dev");
  return null;
}

describe("pollings pausam com a janela oculta e retomam ao voltar visível", () => {
  const hosts: Array<{ host: HTMLDivElement; root: Root }> = [];

  function mount(node: React.ReactNode) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    hosts.push({ host, root });
    return act(async () => { root.render(node); });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
    vi.clearAllMocks();
    mocks.tabContextUsage.mockResolvedValue(null);
    mocks.forgePulls.mockResolvedValue([]);
    mocks.forgePullFiles.mockResolvedValue([]);
    mocks.getTimings.mockResolvedValue({ spans: [], summary: { wallMs: 0, byKind: [], slowest: [] } });
    mocks.getMissionEfficiency.mockResolvedValue(null);
    mocks.getTokens.mockResolvedValue({ agents: [], tabs: [] });
    mocks.missionBudget.mockResolvedValue(null);
    mocks.planLimits.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const { host, root } of hosts.splice(0)) {
      await act(async () => { root.unmount(); });
      host.remove();
    }
    setHidden(false);
    vi.useRealTimers();
  });

  it("AgentSections, SessionPanel, MissionTimingsPanel, MissionTokensPanel, BudgetBar e PlanLimitsPanel pausam quando ocultos", async () => {
    await mount(
      <>
        <ContextSection tab={fakeTab} />
        <PullsProbe />
        <MissionTimingsPanel missionId="m1" />
        <MissionTokensPanel missionId="m1" />
        <BudgetBar missionId="m1" />
        <PlanLimitsPanel />
      </>,
    );
    await flush();

    // Cada painel fez a leitura inicial com a janela visível.
    expect(mocks.tabContextUsage).toHaveBeenCalledTimes(1);
    expect(mocks.forgePulls).toHaveBeenCalledTimes(1);
    expect(mocks.getTimings).toHaveBeenCalledTimes(1);
    expect(mocks.getMissionEfficiency).toHaveBeenCalledTimes(1);
    expect(mocks.getTokens).toHaveBeenCalledTimes(1);
    expect(mocks.missionBudget).toHaveBeenCalledTimes(1);
    expect(mocks.planLimits).toHaveBeenCalledTimes(1);

    // Esconde a janela e avança 10 minutos: NENHUM polling deve disparar.
    await act(async () => { setHidden(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    await flush();

    expect(mocks.tabContextUsage).toHaveBeenCalledTimes(1);
    expect(mocks.forgePulls).toHaveBeenCalledTimes(1);
    expect(mocks.getTimings).toHaveBeenCalledTimes(1);
    expect(mocks.getMissionEfficiency).toHaveBeenCalledTimes(1);
    expect(mocks.getTokens).toHaveBeenCalledTimes(1);
    expect(mocks.missionBudget).toHaveBeenCalledTimes(1);
    expect(mocks.planLimits).toHaveBeenCalledTimes(1);

    // Volta visível: todos fazem pull imediato.
    await act(async () => { setHidden(false); });
    await flush();

    expect(mocks.tabContextUsage).toHaveBeenCalledTimes(2);
    expect(mocks.forgePulls).toHaveBeenCalledTimes(2);
    expect(mocks.getTimings).toHaveBeenCalledTimes(2);
    expect(mocks.getMissionEfficiency).toHaveBeenCalledTimes(2);
    expect(mocks.getTokens).toHaveBeenCalledTimes(2);
    expect(mocks.missionBudget).toHaveBeenCalledTimes(2);
    expect(mocks.planLimits).toHaveBeenCalledTimes(2);
  });
});
