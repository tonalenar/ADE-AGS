/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useChatStore } from "@/features/chat/store";
import { usePlacements } from "../layout/layoutStore";

function Probe() {
  usePlacements();
  return null;
}

describe("usePlacements com o navegador na miniatura", () => {
  // Regressão: o seletor montava um objeto novo a cada leitura e, com a miniatura ligada, o React caía em
  // "Maximum update depth exceeded" ao recolher o painel.
  it("não entra em laço quando o navegador está flutuando", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    useChatStore.setState({
      browser: { viewId: "v1", rect: { left: 0, top: 0, width: 400, height: 700 } },
      browserFloating: true,
      browserFloatRect: { left: 10, top: 10, width: 320, height: 240 },
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    expect(() => act(() => root.render(<Probe />))).not.toThrow();
    expect(error.mock.calls.flat().join(" ")).not.toContain("getSnapshot");
    act(() => root.unmount());
    error.mockRestore();
  });
});
