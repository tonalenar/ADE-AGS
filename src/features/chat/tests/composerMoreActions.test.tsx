// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));

import { ComposerMoreActions } from "../ComposerMoreActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Conta as montagens: uma ação de captura que desmonta ao fechar o menu perderia o estado (a gravação em andamento).
let mounts = 0;
function SecondaryAction() {
  useEffect(() => { mounts += 1; }, []);
  return <button type="button" data-secondary="">Capturar</button>;
}

describe("ComposerMoreActions", () => {
  let host: HTMLDivElement;
  let root: Root;
  const trigger = () => host.querySelector<HTMLButtonElement>("button[aria-controls]")!;
  const menu = () => host.querySelector<HTMLElement>("[role='group']")!;

  beforeEach(() => {
    mounts = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("mantém as ações montadas com o menu fechado, sem perder o estado delas", () => {
    act(() => root.render(<ComposerMoreActions><SecondaryAction /></ComposerMoreActions>));
    expect(mounts).toBe(1);
    act(() => trigger().click());
    act(() => trigger().click());
    act(() => trigger().click());
    expect(mounts).toBe(1);
    expect(host.querySelector("[data-secondary]")).not.toBeNull();
  });

  it("abre pelo gatilho, mostra o menu e fecha com Esc", () => {
    act(() => root.render(<ComposerMoreActions><SecondaryAction /></ComposerMoreActions>));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBe(menu().id);
    expect(menu().className).toContain("hidden");
    act(() => trigger().click());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu().className).not.toContain("hidden");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu().className).toContain("hidden");
  });
});
