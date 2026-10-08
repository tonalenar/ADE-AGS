/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { MemoryInbox } from "../MemoryInbox";
import type { MemoryReviewItem, MemoryWorkspaceReview } from "../types";

const tMock = (key: string, opts?: { count?: number; keys?: string }) => {
  if (opts?.keys) return `${key}: ${opts.keys}`;
  if (opts?.count !== undefined) return `${key} (${opts.count})`;
  return key;
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
  counts: { workspace: 3, byMission: { m1: 3 } },
  load: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../pendingStore", () => ({
  usePendingMemoryStore: (selector: (s: typeof staticPendingState) => unknown) => selector(staticPendingState),
}));

const decideMemoryMock = vi.fn().mockResolvedValue(undefined);
const pendingCountsMock = vi.fn(() => Promise.reject(new Error("sem contagem")));
const draftsMock = vi.fn(() => Promise.resolve([] as unknown[]));
const repoSyncMock = vi.hoisted(() => ({
  getRepoSyncStatus: vi.fn(),
  retryRepoSync: vi.fn(),
}));
let mockReviewSummary: MemoryWorkspaceReview;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceReviewSummary: vi.fn(() => Promise.resolve(mockReviewSummary)),
    listDreams: vi.fn().mockResolvedValue([]),
    decideMemory: (...args: unknown[]) => decideMemoryMock(...args),
    getPendingCounts: () => pendingCountsMock(),
    listMemoryAgentDrafts: () => draftsMock(),
    getRepoSyncStatus: repoSyncMock.getRepoSyncStatus,
    retryRepoSync: repoSyncMock.retryRepoSync,
  };
});

describe("MemoryInbox - componente e atalho Enter (Etapa 24)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const safeItem: MemoryReviewItem = {
    entryId: "entry-safe",
    revision: 1,
    key: "db_cache",
    kind: "decision",
    body: "Cache habilitado em memória",
    priority: 2,
    evidence: {
      runId: "r1",
      taskId: "t1",
      factId: null,
      actorKind: "worker",
      reason: "Performance",
    },
    highValue: false,
    score: 50,
  };

  const contradictionItem: MemoryReviewItem = {
    entryId: "entry-contra",
    revision: 1,
    key: "auth_jwt_exp",
    kind: "constraint",
    body: "JWT expira em 30d",
    priority: 1,
    evidence: {
      runId: "r1",
      taskId: "t1",
      factId: null,
      actorKind: "worker",
      reason: "Sessão longa",
    },
    contradicts: {
      entryId: "entry-existing",
      key: "auth_jwt_exp",
    },
    highValue: false,
    score: 60,
  };

  const duplicateItem: MemoryReviewItem = {
    entryId: "entry-dup",
    revision: 1,
    key: "server_port",
    kind: "finding",
    body: "Porta 8080 configurada",
    priority: 1,
    evidence: {
      runId: "r1",
      taskId: "t1",
      factId: null,
      actorKind: "worker",
      reason: "Porta padrão",
    },
    duplicateOf: {
      entryId: "entry-active-port",
      key: "server_port",
    },
    highValue: false,
    score: 40,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repoSyncMock.getRepoSyncStatus.mockResolvedValue({ workspaceId: "w1", phase: "idle", error: null, commit: null, pending: 0 });
    repoSyncMock.retryRepoSync.mockResolvedValue({ workspaceId: "w1", phase: "queued", error: null, commit: null, pending: 1 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mockReviewSummary = {
      workspaceId: "w1",
      groups: [
        {
          missionId: "m1",
          missionTitle: "Missão 1",
          items: [safeItem, contradictionItem, duplicateItem],
          counts: { total: 3, duplicates: 1, contradictions: 1, highValue: 0 },
        },
      ],
      counts: { total: 3, duplicates: 1, contradictions: 1, highValue: 0 },
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("ao abrir confirmação e pressionar Enter, não aprova contradições nem duplicatas cegamente", async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(<MemoryInbox workspaceId="w1" onClose={onClose} />);
    });

    // 1. Clica em 'Aprovar todas' para abrir o diálogo de confirmação
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const approveAll = buttons.find((b) => b.textContent?.includes("memoryInbox.approveAll"));
    expect(approveAll).toBeDefined();

    await act(async () => {
      approveAll?.click();
    });

    // Confirmação aberta
    const alertDialog = document.body.querySelector('[role="alertdialog"]');
    expect(alertDialog).not.toBeNull();

    // 2. Dispara evento Enter no modal
    const dialogRoot = document.body.querySelector('[role="dialog"]');
    expect(dialogRoot).not.toBeNull();

    await act(async () => {
      dialogRoot?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    // 3. Verifica que APENAS o item seguro foi decidido, e NÃO os que contradizem ou duplicam
    expect(decideMemoryMock).toHaveBeenCalledTimes(1);
    expect(decideMemoryMock).toHaveBeenCalledWith(
      "entry-safe",
      1,
      true,
    );

    // 4. O modal não foi fechado por engano (onClose não deve ser chamado no Enter)
    expect(onClose).not.toHaveBeenCalled();
  });

  it("quando confirm NÃO está aberto, pressionar Enter não executa aprovações", async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(<MemoryInbox workspaceId="w1" onClose={onClose} />);
    });

    const dialogRoot = document.body.querySelector('[role="dialog"]');
    expect(dialogRoot).not.toBeNull();

    await act(async () => {
      dialogRoot?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(decideMemoryMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("quando confirm está aberto, Escape cancela apenas a confirmação sem fechar o inbox", async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(<MemoryInbox workspaceId="w1" onClose={onClose} />);
    });

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const approveAll = buttons.find((b) => b.textContent?.includes("memoryInbox.approveAll"));

    await act(async () => {
      approveAll?.click();
    });

    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();

    const dialogRoot = document.body.querySelector('[role="dialog"]');
    await act(async () => {
      dialogRoot?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    // Alert dialog foi cancelado/fechado
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    // Inbox principal continua aberto
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("quando confirm NÃO está aberto, Escape fecha o inbox chamando onClose", async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(<MemoryInbox workspaceId="w1" onClose={onClose} />);
    });

    const dialogRoot = document.body.querySelector('[role="dialog"]');
    await act(async () => {
      dialogRoot?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("aviso de caixa cheia vem das contagens POR DONO do backend (P3)", async () => {
    const notice = () => document.body.querySelector('[role="status"]')?.textContent ?? "";
    const mount = async () => {
      await act(async () => { root.render(<MemoryInbox workspaceId="w1" onClose={vi.fn()} />); });
      await act(async () => {});
    };
    // 16 do workspace de M1 + 16 do workspace de M2 = 32 no dono workspace: cheio.
    pendingCountsMock.mockImplementation(() => Promise.resolve({ workspace: 32, byMission: { m1: 0, m2: 0 } }) as never);
    await mount();
    expect(notice()).toContain("memoryDrafts.notice.inboxFull.title");
    // 16 workspace + 16 mission de M1: donos diferentes, nenhum cheio.
    act(() => root.unmount());
    root = createRoot(container);
    pendingCountsMock.mockImplementation(() => Promise.resolve({ workspace: 16, byMission: { m1: 16 } }) as never);
    await mount();
    expect(notice()).not.toContain("inboxFull");
    // sem contagem (erro): sem aviso, nunca inventado.
    act(() => root.unmount());
    root = createRoot(container);
    pendingCountsMock.mockImplementation(() => Promise.reject(new Error("x")));
    await mount();
    expect(notice()).not.toContain("inboxFull");
  });
});
