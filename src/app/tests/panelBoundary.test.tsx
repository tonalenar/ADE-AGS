/** @vitest-environment happy-dom */
import { act, lazy, Suspense, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PanelBoundary } from "@/app/PanelBoundary";
import { routes } from "@/app/router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Estado compartilhado com as fábricas de mock (que rodam antes dos imports).
const home = vi.hoisted(() => ({ explode: true }));
const shell = vi.hoisted(() => ({ mounts: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// A página inicial quebra sob comando do teste.
vi.mock("@/features/workspaces/HomePage", () => ({
  HomePage: () => {
    if (home.explode) throw new Error("erro de teste na home");
    return <p>home ok</p>;
  },
}));

// A casca real puxa a app inteira (Tauri, stores). Para este teste basta uma casca com o mesmo `Outlet`:
// o que se prova é que o erro da rota filha não sobe até ela.
vi.mock("@/app/AppShell", async () => {
  const { Outlet } = await import("react-router-dom");
  const { useEffect: useMountEffect } = await import("react");
  return {
    AppShell: function AppShellStub() {
      useMountEffect(() => {
        shell.mounts += 1;
      }, []);
      return <main data-testid="casca"><Outlet /></main>;
    },
  };
});

let explodes = true;
function Explode() {
  if (explodes) throw new Error("boom");
  return <p>painel ok</p>;
}

const irmao = { montagens: 0, desmontagens: 0 };
function Irmao() {
  useEffect(() => {
    irmao.montagens += 1;
    return () => {
      irmao.desmontagens += 1;
    };
  }, []);
  return <p>irmão</p>;
}

function botao(rotulo: string): HTMLButtonElement {
  const achado = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === rotulo);
  if (!achado) throw new Error(`botão "${rotulo}" não encontrado`);
  return achado;
}

describe("PanelBoundary", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    // O React registra os erros capturados no console; o teste os espera, não precisa do ruído.
    vi.spyOn(console, "error").mockImplementation(() => {});
    explodes = true;
    home.explode = true;
    shell.mounts = 0;
    irmao.montagens = 0;
    irmao.desmontagens = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("boundary_mostra_erro_e_mantem_terminais", () => {
    act(() => {
      root.render(
        <>
          <Irmao />
          <PanelBoundary name="x">
            <Explode />
          </PanelBoundary>
        </>,
      );
    });

    expect(host.textContent).toContain("app.panelError.title");
    expect(host.textContent).toContain("irmão");
    // O irmão, fora do boundary, não pode ser desmontado nem remontado pelo erro.
    expect(irmao.montagens).toBe(1);
    expect(irmao.desmontagens).toBe(0);
  });

  it("chunk_lazy_que_falha_cai_no_boundary", async () => {
    // Um chunk que não carrega: o import rejeita, e o React.lazy relança o erro ao renderizar.
    const Chunk = lazy(() => Promise.reject(new Error("chunk falhou")));
    act(() => {
      root.render(
        <PanelBoundary name="x">
          <Suspense fallback={null}>
            <Chunk />
          </Suspense>
        </PanelBoundary>,
      );
    });
    // A rejeição chega pelas microtarefas; sem relógio e sem laço de espera.
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    expect(host.textContent).toContain("app.panelError.title");
  });

  it("tentar_de_novo_volta_a_renderizar_o_painel", () => {
    act(() => {
      root.render(
        <PanelBoundary name="x">
          <Explode />
        </PanelBoundary>,
      );
    });
    expect(host.textContent).toContain("app.panelError.title");

    explodes = false;
    act(() => {
      botao("app.panelError.retry").click();
    });

    expect(host.textContent).toContain("painel ok");
    expect(host.textContent).not.toContain("app.panelError.title");
  });
});

describe("rotas filhas", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    home.explode = true;
    shell.mounts = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("rota_filha_com_erro_nao_troca_a_casca", () => {
    // As rotas exportadas de `router.tsx`, sem cópia: é a árvore de produção que quebra.
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    act(() => {
      root.render(<RouterProvider router={router} />);
    });

    expect(host.querySelector('[data-testid="casca"]')).not.toBeNull();
    expect(shell.mounts).toBe(1);
    expect(host.textContent).toContain("app.panelError.title");
    // O erro de tela cheia da raiz não aparece: ele só serve para quebra do próprio AppShell.
    expect(host.textContent).not.toContain("app.routeError.title");
  });

  it("rota_filha_com_erro_tentar_de_novo_renderiza_a_rota", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    act(() => {
      root.render(<RouterProvider router={router} />);
    });
    expect(host.textContent).toContain("app.panelError.title");

    home.explode = false;
    act(() => {
      botao("app.panelError.retry").click();
    });

    expect(host.textContent).toContain("home ok");
    expect(host.querySelector('[data-testid="casca"]')).not.toBeNull();
    expect(shell.mounts).toBe(1);
  });
});
