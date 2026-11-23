/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag do react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({ enabled: false, memoryApproval: false })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const tMock = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
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

const decideMemoryMock = vi.fn();

import { MemoryInbox } from "../MemoryInbox";
import { MemoryPanel } from "../MemoryPanel";
import { MemoryReviewPanel } from "../MemoryReviewPanel";
import type { MemoryReviewItem, MemoryReviewSummary, MemoryWorkspaceReview } from "../types";

const secretItem: MemoryReviewItem = {
  entryId: "e-sec",
  revision: 2,
  key: "chave_sensivel",
  kind: "note",
  body: "password: hunter2",
  priority: 1,
  evidence: { runId: null, taskId: null, factId: null, actorKind: "user", reason: null },
  highValue: false,
  score: 50,
};

const workspaceReview: MemoryWorkspaceReview = {
  workspaceId: "w1",
  groups: [
    {
      missionId: "m1",
      missionTitle: "Missão 1",
      items: [secretItem],
      counts: { total: 1, duplicates: 0, contradictions: 0, highValue: 0 },
    },
  ],
  counts: { total: 1, duplicates: 0, contradictions: 0, highValue: 0 },
};

const missionReview: MemoryReviewSummary = {
  missionId: "m1",
  items: [secretItem],
  counts: { total: 1, duplicates: 0, contradictions: 0, highValue: 0 },
};

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceReviewSummary: vi.fn(() => Promise.resolve(workspaceReview)),
    getMemoryReviewSummary: vi.fn(() => Promise.resolve(missionReview)),
    listDreams: vi.fn().mockResolvedValue([]),
    decideMemory: (...args: unknown[]) => decideMemoryMock(...args),
    getPendingCounts: vi.fn().mockResolvedValue({ workspace: 1, byMission: { m1: 1 } }),
    listMemoryAgentDrafts: vi.fn().mockResolvedValue([]),
    getRepoSyncStatus: vi.fn().mockResolvedValue({ workspaceId: "w1", phase: "idle", error: null, commit: null, pending: 0 }),
    retryRepoSync: vi.fn(),
  };
});

describe("confirmação de credencial unificada na aprovação (achado 14)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    decideMemoryMock.mockImplementation((_id: string, _rev: number, _approve: boolean, ack?: boolean) => {
      if (!ack) return Promise.reject("CONFIRMACAO_DE_CREDENCIAL: confirme conscientemente");
      return Promise.resolve(undefined);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const findButton = (labelPart: string) =>
    Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(labelPart) || b.getAttribute("aria-label")?.includes(labelPart),
    );

  it("MemoryInbox pede confirmação consciente e reenvia com acknowledgeSecret=true", async () => {
    await act(async () => {
      root.render(<MemoryInbox workspaceId="w1" onClose={vi.fn()} />);
    });
    await act(async () => {
      findButton("memoryReview.approve: chave_sensivel")?.click();
    });
    const confirmBtn = findButton("sharedMemory.confirmApprove");
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      confirmBtn?.click();
    });
    expect(decideMemoryMock).toHaveBeenLastCalledWith("e-sec", 2, true, true);
  });

  it("MemoryPanel pede confirmação consciente e reenvia com acknowledgeSecret=true", async () => {
    await act(async () => {
      root.render(<MemoryPanel workspaceId="w1" workspaceName="WS" />);
    });
    await act(async () => {
      findButton("memoryReview.approve")?.click();
    });
    const confirmBtn = findButton("sharedMemory.confirmApprove");
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      confirmBtn?.click();
    });
    expect(decideMemoryMock).toHaveBeenLastCalledWith("e-sec", 2, true, true);
  });

  it("MemoryReviewPanel pede confirmação consciente e reenvia com acknowledgeSecret=true", async () => {
    await act(async () => {
      root.render(<MemoryReviewPanel missionId="m1" workspaceId="w1" />);
    });
    await act(async () => {
      const approveBtn = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent === "memoryReview.approve",
      );
      approveBtn?.click();
    });
    const confirmBtn = findButton("sharedMemory.confirmApprove");
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      confirmBtn?.click();
    });
    expect(decideMemoryMock).toHaveBeenLastCalledWith("e-sec", 2, true, true);
  });
});
