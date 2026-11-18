/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag do react act no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useScreenRecordingFailures } from "../screenRecordingFailures";

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
  useScreenRecordingFailures();
  return null;
}

describe("falha ao finalizar gravação de tela", () => {
  let container: HTMLDivElement;
  let emitir: ((event: { payload: { id: string; erro: string } }) => void) | undefined;

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

  it("mostra um aviso de erro com o motivo quando o backend diz que a gravação não finalizou", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    expect(mocks.listen).toHaveBeenCalledWith("screen-recording-error", expect.any(Function));
    await act(async () => {
      emitir?.({ payload: { id: "iphone:ABC", erro: "escritor travado" } });
    });
    expect(mocks.alerta).toHaveBeenCalledWith(
      "screenRecording.title",
      "screenRecording.stopFailed:escritor travado",
      "error",
      expect.any(Number),
    );
    await act(async () => {
      root.unmount();
    });
  });
});
