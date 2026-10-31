// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { NotFound } from "@/app/NotFound";
import { RouteError } from "@/app/RouteError";

let root: Root;
let host: HTMLDivElement;
let where = "";
function Shell() { return <div data-testid="casca"><span data-testid="barra" /><Outlet /></div>; }
function Home() { return <p data-testid="inicio">início</p>; }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const mount = (entry: string) => {
  const router = createMemoryRouter([{
    path: "/", element: <Shell />, errorElement: <RouteError />,
    children: [{ index: true, element: <Home /> }, { path: "settings", element: <p>cfg</p> }, { path: "*", element: <NotFound /> }],
  }], { initialEntries: ["/settings", entry], initialIndex: 1 });
  router.subscribe((s) => { where = s.location.pathname; });
  return act(async () => { root.render(<RouterProvider router={router} />); });
};

describe("um caminho desconhecido", () => {
  it("mostra 'Não encontrado' DENTRO da casca (a barra continua), sem cair no erro de tela cheia", async () => {
    await mount("/design");
    expect(host.querySelector("[data-testid=casca]")).not.toBeNull();
    expect(host.querySelector("[data-testid=barra]")).not.toBeNull();
    expect(host.textContent).toContain("app.notFound.title");
    expect(host.textContent).not.toContain("app.routeError.title");
  });

  it("Voltar e Ir para o início funcionam", async () => {
    await mount("/design");
    await act(async () => { ([...host.querySelectorAll("button")].find((b) => b.textContent === "app.notFound.home") as HTMLElement).click(); });
    expect(where).toBe("/");
    expect(host.querySelector("[data-testid=inicio]")).not.toBeNull();
  });
});
