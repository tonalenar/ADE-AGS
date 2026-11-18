/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag do react act no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useRepoSyncFailures } from "../repoSyncFailures";
import type { RepoSyncStatus } from "../types";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  alerta: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { error?: string }) => (opts?.error ? `${key}:${opts.error}` : key),
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@/shared/ui/alerts", () => ({
  AlertaToast: mocks.alerta,
}));

function Probe() {
  useRepoSyncFailures();
  return null;
}

const falha: RepoSyncStatus = {
  workspaceId: "w1",
  phase: "failed",
  error: "memory git failed: simulated outage",
  commit: null,
  pending: 1,
};

describe("falha de exportação do repositório de memória", () => {
  let container: HTMLDivElement;
  let emitir: ((event: { payload: RepoSyncStatus }) => void) | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    emitir = undefined;
    mocks.listen.mockReset();
    mocks.alerta.mockReset();
    mocks.listen.mockImplementation(async (_evento: string, handler: typeof emitir) => {
      emitir = handler;
      return () => undefined;
    });
  });

  afterEach(() => {
    container.remove();
  });

  async function montar() {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    return root;
  }

  it("avisa na tela inteira com o motivo quando a exportação falha", async () => {
    const root = await montar();
    expect(mocks.listen).toHaveBeenCalledWith("cc-memory-repo-sync", expect.any(Function));
    await act(async () => {
      emitir?.({ payload: falha });
    });
    expect(mocks.alerta).toHaveBeenCalledWith(
      "memoryInbox.syncFailedTitle",
      "memoryInbox.syncFailed:memory git failed: simulated outage",
      "error",
      expect.any(Number),
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("não repete o aviso quando novas tentativas falham com o mesmo erro", async () => {
    const root = await montar();
    await act(async () => {
      emitir?.({ payload: falha });
    });
    await act(async () => {
      emitir?.({ payload: falha });
    });
    await act(async () => {
      emitir?.({ payload: { ...falha, pending: 2 } });
    });
    expect(mocks.alerta).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.unmount();
    });
  });

  it("não avisa quando a fila só está na fila ou já sincronizou", async () => {
    const root = await montar();
    await act(async () => {
      emitir?.({ payload: { ...falha, phase: "queued", error: null } });
    });
    await act(async () => {
      emitir?.({ payload: { ...falha, phase: "synced", error: null } });
    });
    expect(mocks.alerta).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});
