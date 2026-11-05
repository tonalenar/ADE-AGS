// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onResized: () => Promise.resolve(() => undefined), isMaximized: () => Promise.resolve(false) }) }));

import { ChatPage } from "../ChatPage";
import { isFullscreenRoute } from "../chatSpaces";
import { StudioToolbar } from "@/features/design/StudioToolbar";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a prancheta em tela cheia", () => {
  it("só a rota da prancheta é tela cheia de verdade (sem a sidebar de Espaços)", () => {
    expect(isFullscreenRoute("/design/abc")).toBe(true);
    expect(isFullscreenRoute("/settings")).toBe(false);
    expect(isFullscreenRoute("/missions")).toBe(false);
  });

  it("tem «Sair da tela cheia» sempre à vista, e o Esc também sai; sem o botão de abrir a sidebar", async () => {
    const onClose = vi.fn();
    const router = createMemoryRouter([{ path: "*", element: (
      <ChatPage onClose={onClose} sidebarOpen={false} fullscreen onExpandSidebar={() => undefined}><div>prancheta</div></ChatPage>
    ) }], { initialEntries: ["/design/abc"] });
    await act(async () => { root.render(<RouterProvider router={router} />); });
    const exit = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("chat.page.exitFullscreen"));
    expect(exit).toBeTruthy();
    expect(host.querySelector("[aria-label='chat.sidebar.expand']")).toBeNull();
    await act(async () => { exit!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("a barra da prancheta", () => {
  it("à direita fica só o de tela cheia: sem o botão de alternar o painel lateral (que parecia duplicado)", async () => {
    const noop = () => undefined;
    await act(async () => {
      root.render(<StudioToolbar pages={[]} pageId={null} onPage={noop} onAddPage={noop} onRenamePage={noop} onDeletePage={noop} onCopyPageLink={noop}
        tool="select" onTool={noop} scale={0.39} onZoomIn={noop} onZoomOut={noop} onFit={noop} onPreset={noop} mod="⌘" focused={null}
        lastDraw="pencil" lastShape="rect" guides={false} onToggleGuides={noop} exportBoard={null}
        trailing={<button type="button" aria-label="tela-cheia" />} />);
    });
    expect(host.querySelector("[aria-label='design.panel.toggle']")).toBeNull();
    expect(host.querySelector("[aria-label='tela-cheia']")).not.toBeNull();
  });
});
