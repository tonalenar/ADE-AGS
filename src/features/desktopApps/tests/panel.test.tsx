// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GeminiDesktopTab from "../GeminiDesktopTab";

const api = vi.hoisted(() => ({
  desktopStatus: vi.fn(), desktopAttach: vi.fn(), desktopDetach: vi.fn(), desktopLayout: vi.fn(), desktopTasks: vi.fn(), executeConsult: vi.fn(), updateConsult: vi.fn(), applyDesktopPlan: vi.fn(),
}));
vi.mock("../ipc", () => api);
vi.mock("../GeminiTeamPanel", () => ({ GeminiTeamPanel: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/features/tabs/layout/layoutStore", () => ({ useLayoutStore: () => false, currentLayout: () => null, focusGroup: vi.fn() }));

const status = { supported: true, installed: true, attached: false, ownerWindow: null, ownerView: null, automaticMessaging: false, orchestration: "assisted" };
const attachedStatus = { ...status, attached: true, ownerWindow: "Gemini", ownerView: "gemini-view", automaticMessaging: true, orchestration: "automatic" };
const task = { id: "review", cwd: "/project", prompt: "Review the design", status: "queued", response: null };
const view = { kind: "desktop" as const, app: "gemini" as const, id: "gemini-view", cwd: "/project", title: "Gemini Desktop" };
let root: Root | null;
let host: HTMLDivElement;
async function click(prefix: string) {
  const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith(prefix));
  expect(button, prefix).toBeDefined();
  await act(async () => { button!.click(); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  api.desktopStatus.mockResolvedValue(status); api.desktopTasks.mockResolvedValue([task]);
  api.desktopAttach.mockResolvedValue(attachedStatus);
  api.desktopDetach.mockResolvedValue(undefined); api.updateConsult.mockResolvedValue(undefined);
  api.desktopLayout.mockResolvedValue(undefined);
  api.executeConsult.mockResolvedValue({ ...task, status: "completed", response: "Reviewed" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; host.remove(); });

describe("Gemini Desktop bridge", () => {
  it("automatically sends queued consultations and captures the response when connected", async () => {
    let current: Array<{ id: string; cwd: string; prompt: string; status: string; response: string | null }> = [task];
    api.desktopTasks.mockImplementation(async () => current);
    api.executeConsult.mockImplementation(async (_viewId: string, _cwd: string, id: string) => {
      const result = { ...task, id, status: "completed", response: "Reviewed" };
      current = [result];
      return result;
    });
    await act(async () => { root!.render(<GeminiDesktopTab view={view} active />); });
    expect(api.desktopAttach).not.toHaveBeenCalled();
    await click("geminiDesktop.connect");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(api.executeConsult).toHaveBeenCalledWith(view.id, view.cwd, task.id);
  });

  it("releases a slow native attachment even if its view was closed before connecting", async () => {
    let connected!: (value: typeof status) => void;
    api.desktopAttach.mockImplementationOnce(() => new Promise((resolve) => { connected = resolve; }));
    await act(async () => { root!.render(<GeminiDesktopTab view={view} active />); });
    await click("geminiDesktop.connect");
    await act(async () => { root!.unmount(); root = null; });
    await act(async () => { connected({ ...status, attached: true }); });
    expect(api.desktopDetach).toHaveBeenCalledWith(view.id);
    expect(api.desktopDetach).toHaveBeenCalledTimes(2);
  });
});
