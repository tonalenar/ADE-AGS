// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const attach = vi.fn(async (_id: number) => "buf");
const total = vi.fn(async (_id: number) => 10);
const visible = vi.fn(() => new Set<string>(["shown"]));
const save = vi.fn(async (_payload: unknown) => undefined);

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: 800, height: 600 }),
  }),
}));
vi.mock("../ipc", () => ({ saveWindowState: (payload: unknown) => save(payload) }));
vi.mock("@/features/terminal/ipc", () => ({
  ptyAttach: (id: number) => attach(id),
  ptyOutputTotal: (id: number) => total(id),
}));
vi.mock("../layout/layoutStore", () => ({
  currentVisibleAgentTabIds: () => visible(),
}));

import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import {
  periodicScrollbackTargets,
  resetScrollbackScheduleForTests,
  runPeriodicScrollbackSave,
  waitForSaves,
} from "../persistence";

function tab(id: string, ptyId: number): Tab {
  return { id, title: id, cwd: "/tmp", agentId: "bash", agentLabel: "bash", command: "bash", ptyId, openedAt: 1 };
}

describe("scrollback periódico", () => {
  beforeEach(() => {
    attach.mockClear();
    total.mockClear();
    save.mockClear();
    total.mockResolvedValue(10);
    visible.mockReturnValue(new Set(["shown"]));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    resetScrollbackScheduleForTests();
    useTabsStore.setState({
      tabs: [tab("shown", 1), tab("hidden", 2)],
      activeTabId: "shown",
      hydrated: true,
      workspaceId: "default",
    });
  });

  it("no incluye la pestaña oculta aunque su buffer haya crecido", () => {
    const targets = periodicScrollbackTargets(
      [{ id: "shown", ptyId: 1 }, { id: "hidden", ptyId: 2 }],
      new Set(["shown"]),
      new Map([[1, 20], [2, 99]]),
      new Map([[1, 20], [2, 1]]),
    );
    expect(targets).toEqual([]);
  });

  it("pide el scrollback solo de la pestaña visible cuyo buffer creció", async () => {
    await runPeriodicScrollbackSave();
    await waitForSaves();
    expect(total).toHaveBeenCalledTimes(1);
    expect(total).toHaveBeenCalledWith(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(1);
    attach.mockClear();
    total.mockClear();
    await runPeriodicScrollbackSave();
    await waitForSaves();
    expect(attach).not.toHaveBeenCalled();
  });

  it("con la página oculta no pide scrollback", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await runPeriodicScrollbackSave();
    await waitForSaves();
    expect(attach).not.toHaveBeenCalled();
    expect(total).not.toHaveBeenCalled();
  });
});
