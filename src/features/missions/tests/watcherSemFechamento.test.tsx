/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ closeTab: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../../bot/arcadeSignals", () => ({ isFinalDelivery: () => false, noteDelivery: () => {}, noteSustained: () => {} }));
vi.mock("../../memory/useMemoryPendingNotice", () => ({ useMemoryPendingNotice: () => null }));
vi.mock("../vigia", () => ({ useVigiaDriver: () => {} }));
vi.mock("../stallAlerts", () => ({ useStallAlerts: () => null }));
vi.mock("../mirror", () => ({ staleMirrors: () => [], unmirrorMission: () => Promise.resolve() }));
vi.mock("@/features/chat/team/teamStore", () => ({
  useTeamStore: (selector: (s: { missionTeams: Record<string, unknown> }) => unknown) => selector({ missionTeams: {} }),
}));
// A missão terminada tem uma aba: a indexação a põe na missão `m1`. Um barrido antigo a fecharia (A163).
vi.mock("../groups", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMissionIndex: () => ({ "tab-m1": "m1" }),
}));

import { useTabsStore } from "@/features/tabs/store";

import { useMissionsStore } from "../store";
import { useMissionWatcher } from "../watcher";

function Probe() {
  useMissionWatcher();
  return null;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.closeTab.mockClear();
  useTabsStore.setState({
    tabs: [{ id: "tab-m1", title: "Backend", cwd: "/projeto", agentId: "codex", agentLabel: "Codex", ptyId: 1 } as never],
    closeTab: mocks.closeTab,
  } as never);
  useMissionsStore.setState({
    missions: [{ id: "m1", title: "Missão", status: "done", cwd: "/projeto", startedAt: 1 } as never],
  } as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe("useMissionWatcher: a aba de missão terminada não é fechada sozinha (A163)", () => {
  it("uma missão concluída deixa a aba aberta, para a pessoa decidir", async () => {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });
});
