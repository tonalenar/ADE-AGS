import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const store = (state: Record<string, unknown>) => ({ getState: () => state, subscribe: vi.fn(() => () => undefined) });
  return {
    tabs: store({ tabs: [{ id: "a", agentId: "codex" }] }),
    canvas: store({ boards: {} }),
    missions: store({ missions: [{ id: "m", status: "running", activeRunId: null }], details: {} }),
    runs: store({ tasks: [], approvals: [] }),
    alerts: store({ alerts: {} }),
    active: [] as string[], sustained: [] as string[], lines: [] as string[],
    outputAt: 1_000_000,
    subscriptions: [] as (() => void)[],
    notifications: [] as ReturnType<typeof vi.fn>[],
  };
});

vi.mock("react", () => ({
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => {
    const listener = vi.fn();
    harness.notifications.push(listener);
    harness.subscriptions.push(subscribe(listener));
    return snapshot();
  },
}));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: harness.tabs }));
vi.mock("@/features/canvas/store", () => ({ useCanvasStore: harness.canvas }));
vi.mock("@/features/missions/groups", () => ({ missionIndex: () => ({ a: "m" }) }));
vi.mock("@/features/missions/store", () => ({ useMissionsStore: harness.missions }));
vi.mock("@/features/missions/stallAlerts", () => ({ useStallAlerts: harness.alerts }));
vi.mock("@/features/runs/store", () => ({ useRunsStore: harness.runs }));
vi.mock("@/features/terminal/terminalRegistry", () => ({ screenOf: () => ({ lines: harness.lines }) }));
vi.mock("@/features/terminal/activity", () => ({
  activeTabIds: () => harness.active,
  sustainedTabIds: () => harness.sustained,
  lastOutputAt: () => harness.outputAt,
  lastInputAt: () => undefined,
}));

import { useMissionIndicatorSignals } from "../useMissionIndicatorSignals";

let documentStub: EventTarget & { visibilityState: string };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  harness.active = []; harness.sustained = []; harness.lines = []; harness.outputAt = 1_000_000;
  harness.notifications = []; harness.subscriptions = [];
  documentStub = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", documentStub);
});
afterEach(() => {
  harness.subscriptions.forEach((unsubscribe) => unsubscribe());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared mission signal subscription", () => {
  it("shares one sampler and publishes only changed signals", () => {
    const first = useMissionIndicatorSignals("m");
    useMissionIndicatorSignals("another");
    expect(vi.getTimerCount()).toBe(1);
    const notifications = harness.notifications[0].mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(harness.notifications[0]).toHaveBeenCalledTimes(notifications);
    harness.sustained = ["a"];
    vi.advanceTimersByTime(1000);
    const next = useMissionIndicatorSignals("m");
    expect(next.workingAgents).toBe(1);
    expect(next).not.toBe(first);
    harness.subscriptions.forEach((unsubscribe) => unsubscribe());
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops sampling while hidden and refreshes immediately when visible", () => {
    const first = useMissionIndicatorSignals("m");
    documentStub.visibilityState = "hidden";
    documentStub.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    harness.sustained = ["a"];
    vi.advanceTimersByTime(5000);
    expect(useMissionIndicatorSignals("m")).toBe(first);
    documentStub.visibilityState = "visible";
    documentStub.dispatchEvent(new Event("visibilitychange"));
    expect(useMissionIndicatorSignals("m").workingAgents).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });
  it("recognizes quiet approval prompts and unanswered questions using the real detector", () => {
    harness.lines = ["Do you want to proceed?"];
    expect(useMissionIndicatorSignals("m").needsAttention).toBe(true);
    harness.lines = ["Which option should we use?"];
    vi.advanceTimersByTime(1000);
    expect(useMissionIndicatorSignals("m").needsAttention).toBe(false);
    vi.advanceTimersByTime(44_000);
    expect(useMissionIndicatorSignals("m").needsAttention).toBe(true);
    harness.active = ["a"];
    vi.advanceTimersByTime(1000);
    expect(useMissionIndicatorSignals("m").needsAttention).toBe(false);
  });
});
