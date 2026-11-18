/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag do react act no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useHousekeepingFailures } from "../housekeepingFailures";

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
  useHousekeepingFailures();
  return null;
}

describe("falha ao subir a puesta a punto", () => {
  let container: HTMLDivElement;
  let emitir: ((event: { payload: string }) => void) | undefined;

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

  it("avisa na tela quando a thread de limpeza não sobe", async () => {
    const root = await montar();
    expect(mocks.listen).toHaveBeenCalledWith("cc-housekeeping-failed", expect.any(Function));
    await act(async () => {
      emitir?.({ payload: "sem recurso" });
    });
    expect(mocks.alerta).toHaveBeenCalledWith(
      "runs.housekeepingFailedTitle",
      "runs.housekeepingFailed:sem recurso",
      "error",
      expect.any(Number),
    );
    await act(async () => {
      root.unmount();
    });
  });
});
