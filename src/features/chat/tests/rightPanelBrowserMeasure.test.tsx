// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/platform", () => ({ DESKTOP_OS: "macos" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const publishSpy = vi.fn();
vi.mock("../browserMeasurement", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../browserMeasurement")>();
  return {
    ...orig,
    publishMeasuredChatBrowser: (...args: Parameters<typeof orig.publishMeasuredChatBrowser>) => {
      publishSpy(...args);
      return orig.publishMeasuredChatBrowser(...args);
    },
  };
});

import { RightPanel } from "../RightPanel";
import { useChatStore } from "../store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

let shell: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  }
  publishSpy.mockClear();
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [], portalViews: [] });
  const viewId = useViewTabsStore.getState().openBrowser("/repo", "https://example.com", { activate: false });
  useChatStore.setState({
    panel: "browser",
    panelMaximized: false,
    panelWidth: 420,
    panelFocus: 0,
    browser: null,
    browserFloating: false,
    browserFloatRect: null,
    surfaces: ["browser"],
    columnTabs: [{ id: "tab-browser", kind: "browser", resources: { "/repo": viewId } }],
    columnActive: "tab-browser",
    devices: { ios: null, android: null },
    deviceNames: { ios: null, android: null },
    deviceControl: false,
  });
  shell = document.createElement("div");
  shell.setAttribute("data-chat-shell", "");
  host = document.createElement("div");
  shell.appendChild(host);
  document.body.appendChild(shell);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  shell.remove();
  vi.restoreAllMocks();
});

describe("BrowserSurface no RightPanel", () => {
  it("nao_remede_o_slot_a_cada_commit_quando_viewId_nao_mudou", () => {
    act(() => root.render(<RightPanel tabId="t1" cwd="/repo" project="repo" />));
    const initialCalls = publishSpy.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    publishSpy.mockClear();
    // Novo render de RightPanel (como durante streaming no chat) sem mudança no slot ou viewId.
    act(() => root.render(<RightPanel tabId="t1" cwd="/repo" project="repo" />));
    act(() => root.render(<RightPanel tabId="t1" cwd="/repo" project="repo" />));

    expect(publishSpy).not.toHaveBeenCalled();
  });
});
