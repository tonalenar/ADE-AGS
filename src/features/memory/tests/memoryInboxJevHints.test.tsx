/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const tMock = (key: string, opts?: Record<string, unknown>) => {
  if (!opts) return key;
  return `${key}:${JSON.stringify(opts)}`;
};
const i18nResult = { t: tMock };
vi.mock("react-i18next", () => ({
  useTranslation: () => i18nResult,
}));

const staticMissionsState = { missions: [{ id: "m1", title: "Missão 1" }] };
vi.mock("@/features/missions/store", () => ({
  useMissionsStore: (selector: (s: typeof staticMissionsState) => unknown) => selector(staticMissionsState),
}));

const staticPendingState = {
  counts: { workspace: 1, byMission: { m1: 1 } },
  load: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../pendingStore", () => ({
  usePendingMemoryStore: (selector: (s: typeof staticPendingState) => unknown) => selector(staticPendingState),
}));

import { MemoryInbox } from "../MemoryInbox";
import type { MemoryWorkspaceReview } from "../types";

const mockReviewSummary: MemoryWorkspaceReview = {
  workspaceId: "w1",
  groups: [
    {
      missionId: "m1",
      missionTitle: "Missão 1",
      items: [
        {
          entryId: "entry-1",
          revision: 1,
          key: "regra_db",
          kind: "decision",
          body: "Usar WAL no SQLite",
          priority: 2,
          evidence: { runId: "r1", taskId: "t1", factId: null, actorKind: "worker", reason: "Estabilidade" },
          highValue: false,
          score: 50,
        },
      ],
      counts: { total: 1, duplicates: 0, contradictions: 0, highValue: 0 },
    },
  ],
  counts: { total: 1, duplicates: 0, contradictions: 0, highValue: 0 },
};

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceReviewSummary: vi.fn(() => Promise.resolve(mockReviewSummary)),
    listDreams: vi.fn().mockResolvedValue([]),
    decideMemory: vi.fn().mockResolvedValue(undefined),
    getPendingCounts: vi.fn().mockResolvedValue({ workspace: 1, byMission: { m1: 1 } }),
    listMemoryAgentDrafts: vi.fn().mockResolvedValue([]),
    getRepoSyncStatus: vi.fn().mockResolvedValue({ workspaceId: "w1", phase: "idle", error: null, commit: null, pending: 0 }),
    retryRepoSync: vi.fn(),
  };
});

describe("MemoryInbox - dicas do Jev (achado 13)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("não consulta decision_memory_hints nem agenda polling quando o Jev está desligado", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "decision_settings_get") {
        return Promise.resolve({ enabled: false, memoryApproval: false });
      }
      if (cmd === "decision_memory_hints") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    await act(async () => {
      root.render(<MemoryInbox workspaceId="w1" onClose={vi.fn()} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const hintCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "decision_memory_hints");
    expect(hintCalls).toHaveLength(0);
  });

  it("mostra probability (não confidence) no tooltip e para de consultar quando todas têm dica", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "decision_settings_get") {
        return Promise.resolve({ enabled: true, memoryApproval: true });
      }
      if (cmd === "decision_memory_hints") {
        return Promise.resolve([
          { index: 0, provider: "jev", action: "aprovar", secret: false, confidence: 0.25, probability: 0.82 },
        ]);
      }
      return Promise.resolve(null);
    });

    await act(async () => {
      root.render(<MemoryInbox workspaceId="w1" onClose={vi.fn()} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const badge = document.body.querySelector('[data-testid="jev-hint"]');
    expect(badge).not.toBeNull();
    const title = badge?.getAttribute("title") ?? "";
    expect(title).toContain('"probability":"82%"');
    expect(title).not.toContain("25%");

    const hintCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "decision_memory_hints");
    expect(hintCalls).toHaveLength(1);
  });
});
