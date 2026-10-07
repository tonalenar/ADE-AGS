/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag do react act no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { RepoSyncNotice } from "../RepoSyncNotice";
import type { RepoSyncStatus } from "../types";

const sync = vi.hoisted(() => ({
  getRepoSyncStatus: vi.fn(),
  retryRepoSync: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { error?: string }) => (opts?.error ? `${key}:${opts.error}` : key),
  }),
}));

vi.mock("../ipc", () => ({
  getRepoSyncStatus: sync.getRepoSyncStatus,
  retryRepoSync: sync.retryRepoSync,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: sync.listen,
}));

const failed: RepoSyncStatus = {
  workspaceId: "w1",
  phase: "failed",
  error: "memory git failed: simulated outage",
  commit: null,
  pending: 1,
};

describe("RepoSyncNotice", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    sync.listen.mockResolvedValue(() => {});
    sync.getRepoSyncStatus.mockResolvedValue({ workspaceId: "w1", phase: "synced", error: null, commit: "abc", pending: 0 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  async function render() {
    await act(async () => { root.render(<RepoSyncNotice workspaceId="w1" />); });
  }

  it("mostra a omissão junto da falha e do botão de tentar de novo", async () => {
    sync.getRepoSyncStatus.mockResolvedValue({
      ...failed,
      warnings: ["Entrada e1@r2 foi omitida da projeção porque parece uma credencial."],
    });
    await render();
    expect(container.textContent).toContain("omitida da projeção");
    expect(container.textContent).toContain("memoryInbox.syncRetry");
    expect(container.textContent).toContain("simulated outage");
  });

  it("esconde quando o repositório já está sincronizado", async () => {
    await render();
    expect(container.textContent).toBe("");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("mostra a falha de exportação sem desfazer a aprovação e oferece retry", async () => {
    sync.getRepoSyncStatus.mockResolvedValue(failed);
    sync.retryRepoSync.mockResolvedValue({ ...failed, phase: "syncing", error: null });
    await render();
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("memoryInbox.syncFailed:memory git failed: simulated outage");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "memoryInbox.syncRetry");
    expect(retry).toBeDefined();
    await act(async () => { retry?.click(); });
    expect(sync.retryRepoSync).toHaveBeenCalledWith("w1");
    expect(container.textContent).toContain("memoryInbox.syncing");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("atualiza a fila quando o evento de sincronização chega", async () => {
    await render();
    const listener = sync.listen.mock.calls.find(([event]) => event === "cc-memory-repo-sync")?.[1] as (event: { payload: RepoSyncStatus }) => void;
    expect(listener).toBeTypeOf("function");
    await act(async () => { listener({ payload: { workspaceId: "w1", phase: "queued", error: null, commit: null, pending: 3 } }); });
    expect(container.textContent).toContain("memoryInbox.syncQueued");
    await act(async () => { listener({ payload: failed }); });
    expect(container.querySelector("[role='alert']")?.textContent).toContain("simulated outage");
    await act(async () => { listener({ payload: { ...failed, workspaceId: "other", phase: "failed", error: "ignored" } }); });
    expect(container.textContent).not.toContain("ignored");
  });
});
