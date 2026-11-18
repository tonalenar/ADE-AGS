// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addPending, PENDING_TTL_MS, usePending, usePendingSends } from "../timeline/pending";

// O hook que a timeline usa: quantos envios ainda esperam o eco.
let count = -1;
function Probe() {
  count = usePending("k", []).length;
  return null;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  usePendingSends.setState({ byKey: {} });
  count = -1;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.useRealTimers(); });

describe("o envio otimista some quando o prazo vence, sem esperar outra mudança", () => {
  it("envio_some_no_vencimento: sem eco, o envio sai da lista assim que o prazo passa", async () => {
    await act(async () => { root.render(<Probe />); });
    act(() => { addPending("k", "mensagem sem eco", []); });
    expect(count).toBe(1);

    // Quase no prazo: ainda aparece.
    await act(async () => { vi.advanceTimersByTime(PENDING_TTL_MS - 1000); });
    expect(count).toBe(1);

    // Passou o prazo, e nada mais mudou na conversa: o envio tem que sair mesmo assim.
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(count).toBe(0);
  });
});
