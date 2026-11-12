// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { BrowserStartPage } from "../BrowserStartPage";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("página inicial do navegador", () => {
  it("mostra o estado vazio", () => {
    act(() => root.render(<BrowserStartPage recentPages={[]} servers={[]} onClearRecent={() => undefined} onNavigate={() => undefined} />));
    expect(host.textContent).toContain("browser.start.title");
    expect(host.textContent).toContain("browser.start.desc");
    expect(host.textContent).toContain("browser.start.none");
  });

  it("mostra o servidor local detectado e navega ao selecioná-lo", () => {
    const navigate = vi.fn();
    act(() => root.render(<BrowserStartPage recentPages={[]} servers={["http://localhost:4173"]} onClearRecent={() => undefined} onNavigate={navigate} />));
    const server = [...host.querySelectorAll("button")].find((button) => button.textContent === "localhost:4173");
    expect(server).toBeDefined();
    act(() => server?.click());
    expect(navigate).toHaveBeenCalledWith("http://localhost:4173");
  });
});
