import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  comparePrepare: vi.fn(),
  compareAttach: vi.fn(),
  buildComparison: vi.fn(),
  upsertComparison: vi.fn(),
  setWorkMode: vi.fn(),
  addTab: vi.fn(),
  activateTab: vi.fn(),
}));

vi.mock("../ipc", () => ({
  comparePrepare: mocks.comparePrepare,
  compareAttach: mocks.compareAttach,
  compareFinish: vi.fn(),
  compareKeep: vi.fn(),
  compareRemove: vi.fn(),
}));
vi.mock("../store", () => ({
  loadComparisons: vi.fn(),
  setPending: vi.fn(),
  upsertComparison: mocks.upsertComparison,
  useCompareStore: { getState: () => ({ comparisons: [] }) },
}));
vi.mock("@/features/canvas/store", () => ({
  canvasActions: { buildComparison: mocks.buildComparison },
  compareBoardKey: () => "board",
  setWorkMode: mocks.setWorkMode,
}));
vi.mock("@/features/canvas/board", () => ({ TEXT_PREFIX: "text:" }));
vi.mock("@/features/missions/autonomy", () => ({ getAutonomy: () => "auto", withAutonomy: (_id: string, cmd: string) => cmd }));
vi.mock("@/features/missions/modelFlags", () => ({ withModel: (_id: string, cmd: string) => cmd }));
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: {
    getState: () => ({
      addTab: mocks.addTab,
      activateTab: mocks.activateTab,
      detectedAgents: [
        { id: "claude", label: "Claude", command: "claude", available: true },
        { id: "codex", label: "Codex", command: "codex", available: true },
      ],
    }),
  },
}));
vi.mock("@/features/terminal/terminalRegistry", () => ({ sendWhenReady: vi.fn() }));
vi.mock("@/features/chat/attachments/send", () => ({ tuiMessage: (_id: string, prompt: string) => prompt }));
vi.mock("@/shared/ui/appConfirm", () => ({ appConfirm: vi.fn() }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));

import { startComparison } from "../start";

const input = {
  cwd: "/repo",
  title: "Comparar",
  prompt: "faça X",
  isolate: false,
  isRepo: false,
  picks: [
    { agentId: "claude", model: null, effort: null, fast: false },
    { agentId: "codex", model: null, effort: null, fast: false },
  ],
};

describe("A501 startComparison: attach falhou", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addTab.mockImplementation(() => "tab");
    mocks.comparePrepare.mockImplementation(async (args: { title: string; cwd: string; picks: Array<{ pick: string; label: string; agentId: string }> }) => ({
      comparison: {
        id: "c1", title: args.title, slug: "s", cwd: args.cwd, repo: null, base: null, isolated: false, createdAt: 0, kept: null,
        entries: args.picks.map((p) => ({ pick: p.pick, label: p.label, agentId: p.agentId, cwd: args.cwd, branch: null, tabId: null })),
      },
      setups: [],
    }));
    mocks.compareAttach.mockRejectedValue(new Error("attach falhou"));
  });

  it("não monta o canvas, não grava e devolve o erro ao diálogo", async () => {
    await expect(startComparison(input)).rejects.toThrow("attach falhou");
    expect(mocks.buildComparison).not.toHaveBeenCalled();
    expect(mocks.upsertComparison).not.toHaveBeenCalled();
  });

  it("attach que resolve null conta como falha: não monta o canvas nem grava", async () => {
    mocks.compareAttach.mockResolvedValue(null);
    await expect(startComparison(input)).rejects.toThrow();
    expect(mocks.buildComparison).not.toHaveBeenCalled();
    expect(mocks.upsertComparison).not.toHaveBeenCalled();
  });
});
