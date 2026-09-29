import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/runs/ipc", () => ({
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
}));

import * as runsIpc from "@/features/runs/ipc";
import { useRunsStore } from "@/features/runs/store";
import type { PendingApproval, Task } from "@/features/runs/types";

import { approvalsFor, missionPhase } from "../missionView";

const ipc = vi.mocked(runsIpc);

const approval = (id: string, taskId: string): PendingApproval => ({
  id, taskId, toolName: "Write", input: { file_path: "/p/a.txt", content: "x" }, askedAt: 1, suggestedRule: "Write(/p/a.txt)",
});

const tasks = [{ id: "t1", runId: "r1" }, { id: "t2", runId: "r1" }] as Task[];

/** Lo que la misión muestra, leyendo la MISMA cola que la flota. */
const missionView = () => {
  const pending = approvalsFor(useRunsStore.getState().approvals, tasks);
  return { pending: pending.map((a) => a.id), phase: missionPhase("running", pending.length > 0) };
};

beforeEach(() => {
  vi.resetAllMocks();
  useRunsStore.setState({ approvals: [] });
});

describe("la misión lee la cola de permisos de la flota", () => {
  it("el evento de la cola pone a la misión esperando aprobación", () => {
    expect(missionView()).toEqual({ pending: [], phase: "running" });
    // Es lo que hace `useFleetEvents` al recibir `cc-task-approvals`.
    useRunsStore.getState().setApprovals([approval("a1", "t1"), approval("otro", "t9")]);
    expect(missionView()).toEqual({ pending: ["a1"], phase: "waiting_approval" });
  });

  it("Allow desde la misión llama al mismo backend y la flota deja de verlo", async () => {
    ipc.decideApproval.mockResolvedValue(true);
    useRunsStore.getState().setApprovals([approval("a1", "t1")]);
    await useRunsStore.getState().decideApproval("a1", true, false);
    expect(ipc.decideApproval).toHaveBeenCalledWith("a1", true, false);
    expect(useRunsStore.getState().approvals).toEqual([]);
    expect(missionView().phase).toBe("running");
  });

  it("Deny con recordar pasa tal cual, con la semántica de la flota", async () => {
    ipc.decideApproval.mockResolvedValue(true);
    useRunsStore.getState().setApprovals([approval("a1", "t2")]);
    await useRunsStore.getState().decideApproval("a1", false, true);
    expect(ipc.decideApproval).toHaveBeenCalledWith("a1", false, true);
    expect(missionView().pending).toEqual([]);
  });

  it("una decisión tomada en la flota (el evento con la cola nueva) libera a la misión", () => {
    useRunsStore.getState().setApprovals([approval("a1", "t1"), approval("a2", "t2")]);
    expect(missionView().pending).toEqual(["a1", "a2"]);
    useRunsStore.getState().setApprovals([approval("a2", "t2")]);
    expect(missionView()).toEqual({ pending: ["a2"], phase: "waiting_approval" });
    useRunsStore.getState().setApprovals([]);
    expect(missionView().phase).toBe("running");
  });
});
