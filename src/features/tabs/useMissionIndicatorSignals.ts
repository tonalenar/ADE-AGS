import { useSyncExternalStore } from "react";

import { useCanvasStore } from "@/features/canvas/store";
import { missionIndex } from "@/features/missions/groups";
import { SCREEN_QUESTION_QUIET_MS, screenQuestion } from "@/features/missions/leadStall";
import { useStallAlerts } from "@/features/missions/stallAlerts";
import { isWaitingForUser } from "@/features/missions/stalled";
import { useMissionsStore } from "@/features/missions/store";
import { useRunsStore } from "@/features/runs/store";
import { activeTabIds, lastInputAt, lastOutputAt, sustainedTabIds } from "@/features/terminal/activity";
import { screenOf } from "@/features/terminal/terminalRegistry";
import { useTabsStore } from "./store";
import type { MissionIndicatorSignals } from "./missionIndicator";
import { collectMissionIndicatorSignals, stableMissionIndicatorSignals } from "./missionIndicatorSignals";

const EMPTY: MissionIndicatorSignals = { status: "", workingAgents: 0, needsAttention: false };
let snapshots: Record<string, MissionIndicatorSignals> = {};
const listeners = new Set<() => void>();
let dispose: (() => void) | undefined;

function refresh(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const { tabs } = useTabsStore.getState();
  const { missions, details } = useMissionsStore.getState();
  const { tasks, approvals } = useRunsStore.getState();
  const now = Date.now();
  const active = new Set(activeTabIds(now));
  const next = stableMissionIndicatorSignals(snapshots, collectMissionIndicatorSignals({
    missions,
    tabs,
    // The exact membership function underlying useMissionIndex and the Ao vivo view.
    missionIndex: missionIndex(useCanvasStore.getState().boards, tabs),
    sustainedTabIds: sustainedTabIds(now),
    attentionTabIds: tabs.filter((tab) => {
      if (tab.agentId === "bash" || active.has(tab.id)) return false;
      const lines = screenOf(tab.id, null, 8)?.lines ?? [];
      if (isWaitingForUser(lines)) return true;
      // Reuse Etapa 16's question recognizer and silence threshold, not every '?' in output.
      const lastSignal = Math.max(lastOutputAt(tab.id) ?? now, lastInputAt(tab.id) ?? 0);
      return now - lastSignal >= SCREEN_QUESTION_QUIET_MS && screenQuestion(lines) !== null;
    }).map((tab) => tab.id),
    alertMissionIds: Object.entries(useStallAlerts.getState().alerts).filter(([, alerts]) => alerts.length > 0).map(([id]) => id),
    tasks: [...Object.values(details).flatMap((detail) => detail.tasks), ...tasks],
    approvalTaskIds: approvals.map((approval) => approval.taskId),
  }));
  const changed = Object.keys(next).length !== Object.keys(snapshots).length
    || Object.keys(next).some((id) => next[id] !== snapshots[id]);
  if (!changed) return;
  snapshots = next;
  for (const listener of listeners) listener();
}

/** One shared signal sampler, regardless of the number of mounted mission tabs. */
function start(): () => void {
  const unsubscribers = [useTabsStore, useCanvasStore, useMissionsStore, useRunsStore, useStallAlerts]
    .map((store) => store.subscribe(refresh));
  let timer: ReturnType<typeof setInterval> | undefined;
  const resume = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    refresh();
    timer = setInterval(refresh, 1000);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
  resume();
  return () => {
    if (timer !== undefined) clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    snapshots = {};
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) dispose = start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { dispose?.(); dispose = undefined; }
  };
}

/** Mount this in the individual indicator: unrelated missions retain their snapshot identity. */
export function useMissionIndicatorSignals(missionId: string): MissionIndicatorSignals {
  return useSyncExternalStore(subscribe, () => snapshots[missionId] ?? EMPTY, () => EMPTY);
}
