import type { MissionIndicatorSignals } from "./missionIndicator";

interface SignalSources {
  missions: readonly { id: string; status: string; activeRunId: string | null }[];
  tabs: readonly { id: string; agentId: string }[];
  missionIndex: Readonly<Record<string, string>>;
  sustainedTabIds: readonly string[];
  attentionTabIds: readonly string[];
  alertMissionIds: readonly string[];
  tasks: readonly { id: string; runId: string }[];
  approvalTaskIds: readonly string[];
}

/** Aggregate only real terminal membership and approvals belonging to the mission's active run. */
export function collectMissionIndicatorSignals(input: SignalSources): Record<string, MissionIndicatorSignals> {
  const result: Record<string, MissionIndicatorSignals> = {};
  const sustained = new Set(input.sustainedTabIds);
  const attention = new Set(input.attentionTabIds);
  const alerted = new Set(input.alertMissionIds);
  const approvedTasks = new Set(input.approvalTaskIds);
  const blockedRuns = new Set(input.tasks.filter((task) => approvedTasks.has(task.id)).map((task) => task.runId));
  for (const mission of input.missions) {
    result[mission.id] = {
      status: mission.status,
      workingAgents: 0,
      needsAttention: alerted.has(mission.id) || (!!mission.activeRunId && blockedRuns.has(mission.activeRunId)),
    };
  }
  for (const tab of input.tabs) {
    if (tab.agentId === "bash") continue;
    const signals = result[input.missionIndex[tab.id]];
    if (!signals) continue;
    if (sustained.has(tab.id)) signals.workingAgents++;
    if (attention.has(tab.id)) signals.needsAttention = true;
  }
  return result;
}

/** Keep per-mission snapshots stable even when another mission or an unrelated store changes. */
export function stableMissionIndicatorSignals(
  previous: Readonly<Record<string, MissionIndicatorSignals>>,
  next: Record<string, MissionIndicatorSignals>,
): Record<string, MissionIndicatorSignals> {
  for (const [id, signals] of Object.entries(next)) {
    const old = previous[id];
    if (old && old.status === signals.status && old.workingAgents === signals.workingAgents && old.needsAttention === signals.needsAttention) {
      next[id] = old;
    }
  }
  return next;
}
