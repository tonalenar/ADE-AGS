/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorArea } from "@/features/tabs/EditorArea";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Conta montagens e desmontagens do `TerminalPanel`: desmontá-lo mata os PTYs, então é isso que se vigia.
const painel = vi.hoisted(() => ({ montagens: 0, desmontagens: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/features/canvas/chatUnread", () => ({ useChatUnreadWatcher: () => {} }));
vi.mock("@/features/missions/watcher", () => ({ useMissionWatcher: () => {} }));
vi.mock("@/features/tabs/ViewTabsHost", () => ({ ViewTabsHost: () => null }));
vi.mock("@/features/canvas/gridMode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/gridMode")>()),
  useMissionGrid: () => null,
}));
// O modo canvas precisa estar ligado para o `CanvasView` (o lazy) entrar na árvore.
vi.mock("@/features/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/store")>()),
  useWorkMode: () => "canvas",
}));
vi.mock("@/features/terminal/TerminalPanel", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalPanel: function TerminalPanelStub() {
      useEffect(() => {
        painel.montagens += 1;
        return () => {
          painel.desmontagens += 1;
        };
      }, []);
      return <div data-testid="terminais" />;
    },
  };
});
// O canvas quebra ao renderizar: é o caso do chunk que falha ou de um erro de dado.
vi.mock("@/features/canvas/CanvasView", () => ({
  CanvasView: function CanvasQuebrado(): never {
    throw new Error("canvas quebrou");
  },
}));

/** Deixa o lazy do canvas resolver e o erro subir até o boundary, pelas microtarefas. Sem relógio. */
async function assentar() {
  // O módulo já carregado: o `lazy` do EditorArea resolve pela mesma importação em cache.
  await import("@/features/canvas/CanvasView");
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

describe("EditorArea e erros de filho", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    painel.montagens = 0;
    painel.desmontagens = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("canvas_que_quebra_nao_mata_terminais", async () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <MemoryRouter initialEntries={["/workspace"]}>
            <EditorArea />
          </MemoryRouter>
        </ThemeProvider>,
      );
    });
    await assentar();

    // O canvas mostra o aviso no próprio lugar, e o TerminalPanel nunca é desmontado.
    expect(host.textContent).toContain("app.panelError.title");
    expect(host.querySelector('[data-testid="terminais"]')).not.toBeNull();
    expect(painel.montagens).toBe(1);
    expect(painel.desmontagens).toBe(0);
  });
});
