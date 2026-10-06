import { describe, expect, it } from "vitest";
import { collectMissionIndicatorSignals, stableMissionIndicatorSignals } from "../missionIndicatorSignals";

const sources = () => ({
  missions: [
    { id: "m1", status: "running", activeRunId: "r1" },
    { id: "m2", status: "running", activeRunId: "r2" },
  ],
  tabs: [{ id: "a", agentId: "codex" }, { id: "b", agentId: "claude" }, { id: "sh", agentId: "bash" }, { id: "free", agentId: "codex" }],
  missionIndex: { a: "m1", b: "m2", sh: "m1" },
  sustainedTabIds: ["a", "sh", "free", "closed"],
  attentionTabIds: [] as string[],
  alertMissionIds: [] as string[],
  tasks: [{ id: "task1", runId: "r1" }, { id: "old", runId: "oldRun" }],
  approvalTaskIds: [] as string[],
});

describe("mission indicator signal collection", () => {
  it("counts only sustained agent terminals indexed to that mission", () => {
    expect(collectMissionIndicatorSignals(sources())).toEqual({
      m1: { status: "running", workingAgents: 1, needsAttention: false },
      m2: { status: "running", workingAgents: 0, needsAttention: false },
    });
  });
  it("maps a waiting prompt to its mission and ignores shells and free terminals", () => {
    const input = sources();
    input.attentionTabIds = ["b", "sh", "free"];
    expect(collectMissionIndicatorSignals(input)).toMatchObject({ m1: { needsAttention: false }, m2: { needsAttention: true } });
  });
  it("uses only approvals in the mission's active run", () => {
    const input = sources();
    input.approvalTaskIds = ["old", "unrelated"];
    expect(collectMissionIndicatorSignals(input).m1.needsAttention).toBe(false);
    input.approvalTaskIds.push("task1");
    expect(collectMissionIndicatorSignals(input)).toMatchObject({ m1: { needsAttention: true }, m2: { needsAttention: false } });
  });
  it("propagates and clears existing stall alerts", () => {
    const input = sources();
    input.alertMissionIds = ["m2"];
    expect(collectMissionIndicatorSignals(input).m2.needsAttention).toBe(true);
    input.alertMissionIds = [];
    expect(collectMissionIndicatorSignals(input).m2.needsAttention).toBe(false);
  });
  it("retains unchanged mission identities while activity moves with membership", () => {
    const input = sources();
    const previous = collectMissionIndicatorSignals(input);
    expect(stableMissionIndicatorSignals(previous, collectMissionIndicatorSignals(input)).m1).toBe(previous.m1);
    input.sustainedTabIds.push("b");
    const next = stableMissionIndicatorSignals(previous, collectMissionIndicatorSignals(input));
    expect(next.m1).toBe(previous.m1);
    expect(next.m2).not.toBe(previous.m2);
    input.missionIndex.a = "m2";
    expect(collectMissionIndicatorSignals(input)).toMatchObject({ m1: { workingAgents: 0 }, m2: { workingAgents: 2 } });
  });
  it("removes closed missions from the snapshot", () => {
    const input = sources();
    const previous = collectMissionIndicatorSignals(input);
    input.missions = input.missions.slice(1);
    expect(stableMissionIndicatorSignals(previous, collectMissionIndicatorSignals(input))).not.toHaveProperty("m1");
  });
});
