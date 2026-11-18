/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, args?: Record<string, string>) => args?.error ? `${key} ${args.error}` : key }) }));
vi.mock("neogestify-ui-components", () => ({ Button: ({ children }: { children: React.ReactNode }) => createElement("button", null, children), CloseIcon: () => null }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: fake.toast }));
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: (select: (state: unknown) => unknown) => select({ tabs: [{ id: "tab", cwd: "/projeto", agentId: "codex" }], activeTabId: "tab" }),
}));
vi.mock("@/features/tabs/viewTabs", () => ({ comparablePath: (path: string) => path }));
vi.mock("@/features/tabs/tabActions", () => ({ openNewAgentWith: vi.fn() }));
vi.mock("../NewFloorDialog", () => ({ NewFloorDialog: () => null }));
vi.mock("../LandFloorDialog", () => ({ LandFloorDialog: () => null }));
vi.mock("@/shared/ui/ContextMenu", () => ({ ContextMenu: () => null }));

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { FloorBar } from "../FloorBar";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fake.invoke.mockReset().mockRejectedValue(new Error("floors.json.corrupt-123"));
  fake.toast.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("falha ao listar andares", () => {
  it("avisa com o caminho da cópia preservada", async () => {
    await act(async () => {
      root.render(createElement(FloorBar));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fake.invoke).toHaveBeenCalledWith("floor_list", { cwd: "/projeto" });
    expect(fake.toast).toHaveBeenCalledWith("canvas.floor.title", expect.stringContaining("floors.json.corrupt-123"), "warning", 9000);
    expect(host.textContent).toBe("");
  });
});
