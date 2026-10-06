import { describe, expect, it } from "vitest";

import type { Task } from "@/features/runs/types";
import { fleetGroups } from "../fleet";

const task = (id: string, status: string) => ({ id, status }) as unknown as Task;
const tab = (id: string, agentId = "claude") => ({ id, title: `T-${id}`, agentId, agentLabel: agentId });

describe("fleetGroups", () => {
  const base = {
    missions: [
      { id: "m1", title: "Uno", status: "running" },
      { id: "m2", title: "Dos", status: "done" },
      { id: "m3", title: "Tres", status: "running" },
      { id: "m4", title: "Borrador", status: "draft" },
    ],
    tasksByMission: { m1: [task("a", "running"), task("b", "done"), task("c", "pending")], m2: [task("z", "running")] },
    tabs: [tab("t1"), tab("t2"), tab("t3", "bash"), tab("t4"), tab("free")],
    missionIndex: { t1: "m1", t2: "m1", t3: "m1", t4: "m2" },
    sustainedTabIds: ["t1"],
  };

  it("solo las misiones en curso, con sus tareas activas y sus terminales reales", () => {
    const groups = fleetGroups(base);
    expect(groups.map((g) => g.missionId)).toEqual(["m1", "m3"]);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(groups[0]!.terminals.map((t) => [t.tabId, t.working])).toEqual([["t1", true], ["t2", false]]);
  });

  it("una misión en curso sin nada abierto sale vacía; no se inventa nada", () => {
    const m3 = fleetGroups(base)[1]!;
    expect(m3.tasks).toEqual([]);
    expect(m3.terminals).toEqual([]);
  });

  it("sin misiones en curso no hay grupos", () => {
    expect(fleetGroups({ ...base, missions: [{ id: "x", title: "x", status: "failed" }] })).toEqual([]);
  });
});
