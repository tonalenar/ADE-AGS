/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const win = vi.hoisted(() => {
  const unlisten = vi.fn();
  return {
    unlisten,
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => unlisten),
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
  };
});

vi.mock("@/app/platform", () => ({ DESKTOP_OS: "windows", osFromUserAgent: () => "windows" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/app/closeWithSave", () => ({ closeWindowWithSave: vi.fn() }));

import { WindowControls } from "../WindowLights";

describe("WindowControls", () => {
  let root: Root;
  let host: HTMLDivElement;
  let mounted = false;

  beforeEach(() => {
    win.unlisten.mockClear();
    win.isMaximized.mockClear();
    win.onResized.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    host.remove();
  });

  it("o efeito de maximizado inscreve uma vez e solta no unmount", async () => {
    act(() => { root.render(<WindowControls />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(win.onResized).toHaveBeenCalledTimes(1);
    act(() => { root.render(<WindowControls />); });
    await act(async () => { await Promise.resolve(); });
    expect(win.onResized).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    mounted = false;
    await act(async () => { await Promise.resolve(); });
    expect(win.unlisten).toHaveBeenCalledTimes(1);
  });
});
