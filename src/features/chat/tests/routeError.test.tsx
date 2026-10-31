// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { RouteError } from "@/app/RouteError";

let root: Root;
let host: HTMLDivElement;
function Boom(): never { throw new Error("falha no render"); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });

const mount = (entry: string) => act(async () => {
  const router = createMemoryRouter([{ path: "/", element: <Boom />, errorElement: <RouteError /> }], { initialEntries: [entry] });
  root.render(<RouterProvider router={router} />);
});

describe("a tela de erro", () => {
  it("tem fundo sólido (a janela do app é transparente) e mostra a mensagem e a pilha curta", async () => {
    await mount("/");
    const alert = host.querySelector("[role=alert]") as HTMLElement;
    expect(alert.className).toContain("bg-white");
    expect(alert.className).toContain("dark:bg-surface-deep");
    expect(alert.textContent).toContain("falha no render");
    expect(host.querySelector("pre")?.textContent).toContain("Error: falha no render");
  });

  it("uma rota que não existe mostra o 404, também sobre fundo sólido", async () => {
    await mount("/nao-existe");
    const alert = host.querySelector("[role=alert]") as HTMLElement;
    expect(alert.textContent).toContain("404");
    expect(alert.className).toContain("bg-white");
  });
});
