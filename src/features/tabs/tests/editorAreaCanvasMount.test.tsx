// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O modo do canvas é trocado pelo teste; o canvas real e as partes pesadas da área ficam de fora.
let mode: "canvas" | "tabs" = "canvas";
let mounts = 0;
let unmounts = 0;
let terminalMounts = 0;
let terminalUnmounts = 0;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "k" }), useNavigate: () => () => undefined }));
vi.mock("@/features/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/store")>()),
  useWorkMode: () => mode,
}));
vi.mock("@/features/canvas/CanvasView", async () => {
  const { createElement, useEffect } = await import("react");
  return {
    CanvasView: function CanvasViewMock() {
      useEffect(() => {
        mounts++;
        return () => { unmounts++; };
      }, []);
      return createElement("div", { "data-testid": "canvas" });
    },
  };
});
vi.mock("@/features/canvas/chatUnread", () => ({ useChatUnreadWatcher: () => undefined }));
vi.mock("@/features/missions/watcher", () => ({ useMissionWatcher: () => undefined }));
vi.mock("@/features/terminal/TerminalPanel", async () => {
  const { createElement, useEffect } = await import("react");
  return {
    TerminalPanel: function TerminalPanelMock() {
      useEffect(() => {
        terminalMounts++;
        return () => { terminalUnmounts++; };
      }, []);
      return createElement("div", { "data-testid": "terminal-panel" });
    },
  };
});
vi.mock("@/features/tabs/ViewTabsHost", () => ({ ViewTabsHost: () => null }));
vi.mock("@/features/tabs/ProtocolPane", () => ({ ProtocolPane: () => null }));
vi.mock("@/features/chat/team/TeamTabMarks", () => ({ TeamTabMarks: () => null }));

import { EditorArea } from "@/features/tabs/EditorArea";
import { useCanvasStore } from "@/features/canvas/store";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useCanvasStore.setState({ activeThread: null });
  mounts = 0;
  unmounts = 0;
  terminalMounts = 0;
  terminalUnmounts = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function settle() {
  // O canvas entra por `lazy`: algumas voltas de promessas até o módulo mockado aparecer.
  for (let i = 0; i < 3; i++) await act(async () => undefined);
}

describe("canvas no modo Abas", () => {
  it("trocar_para_abas_nao_desmonta_o_canvas", async () => {
    mode = "canvas";
    act(() => root.render(<EditorArea />));
    await settle();
    expect(mounts).toBe(1);

    mode = "tabs";
    act(() => root.render(<EditorArea />));
    await settle();

    // O canvas segue montado (os Portais também): só sai da tela.
    expect(unmounts).toBe(0);
    expect(host.querySelector('[data-testid="canvas"]')).not.toBeNull();
  });

  it("trocar de conversa não desmonta o TerminalPanel nem o canvas já montado", async () => {
    mode = "canvas";
    useCanvasStore.setState({ activeThread: { ref: "thread:previous", key: "main|/repo#s:thread:previous" } });
    act(() => root.render(<EditorArea />));
    await settle();
    expect(terminalMounts).toBe(1);
    expect(mounts).toBe(1);

    // Troca a conversa e a chave ativa; os pontos de montagem dos terminais e do canvas são os mesmos.
    act(() => useCanvasStore.setState({ activeThread: { ref: "thread:next", key: "main|/repo#s:thread:next" } }));
    act(() => root.render(<EditorArea />));
    await settle();
    expect(terminalUnmounts).toBe(0);
    expect(unmounts).toBe(0);
  });
});
