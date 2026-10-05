import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  listMissions: vi.fn(),
  getMission: vi.fn(),
  createMission: vi.fn(),
  updateMission: vi.fn(),
  startMission: vi.fn(),
  cancelMission: vi.fn(),
}));

import * as ipc from "../ipc";
import { resetMissionsStore, useMissionsStore } from "../store";
import type { Mission, MissionDetail, MissionInput, MissionStatus, MissionSummary } from "../types";

const m = vi.mocked(ipc);

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    workspaceId: "w",
    title: "Hola",
    objective: "Crear hello.txt contendo ADE AGS",
    cwd: "/tmp/proy",
    status: "draft",
    maxParallel: 2,
    budgetUsd: null,
    leadAgentId: null,
    leadModel: null,
    leadAccountId: null,
    autoAccount: true,
    complexity: "hard",
    activeRunId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    endedAt: null,
    ...patch,
  };
}

const summary = (patch: Partial<Mission> = {}, tasks = { workersDone: 0, workersTotal: 0 }): MissionSummary => ({
  ...mission(patch), spentUsd: 0, leadAgent: null, leadStatus: null, activeSeconds: null, ...tasks,
});

const detail = (patch: Partial<Mission> = {}): MissionDetail => ({ mission: mission(patch), delivery: null, runs: [], tasks: [], facts: [] });

const input: MissionInput = {
  title: "Hola", objective: "o", cwd: "/tmp/proy", maxParallel: 2, budgetUsd: null,
  leadAgentId: null, leadModel: null, leadAccountId: null, autoAccount: true, complexity: "hard",
};

/** Lo que la base tiene "ahora": lo que devuelven list/get. */
function backend(status: MissionStatus, tasks = { workersDone: 0, workersTotal: 0 }) {
  const runId = status === "draft" ? null : "r1";
  m.listMissions.mockResolvedValue([summary({ status, activeRunId: runId }, tasks)]);
  m.getMission.mockResolvedValue(detail({ status, activeRunId: runId }));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetMissionsStore();
});

describe("missions store", () => {
  it("lista vacía", async () => {
    m.listMissions.mockResolvedValue([]);
    await useMissionsStore.getState().load("w");
    const s = useMissionsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.missions).toEqual([]);
    expect(m.getMission).not.toHaveBeenCalled();
  });

  it("crear guarda un borrador y no lo arranca", async () => {
    m.createMission.mockResolvedValue(mission());
    backend("draft");
    const created = await useMissionsStore.getState().create("w", input);
    expect(created.status).toBe("draft");
    expect(m.createMission).toHaveBeenCalledWith("w", input);
    expect(m.startMission).not.toHaveBeenCalled();
    const s = useMissionsStore.getState();
    expect(s.missions.map((x) => x.status)).toEqual(["draft"]);
    expect(s.details.m1.mission.status).toBe("draft");
  });

  it("editar relee la lista y el detalle", async () => {
    m.updateMission.mockResolvedValue(mission({ title: "Otro" }));
    backend("draft");
    await useMissionsStore.getState().update("w", "m1", { ...input, title: "Otro" });
    expect(m.updateMission).toHaveBeenCalledWith("m1", { ...input, title: "Otro" });
    expect(m.getMission).toHaveBeenCalledWith("m1");
  });

  it("start pasa a running con su run", async () => {
    m.startMission.mockResolvedValue(mission({ status: "running", activeRunId: "r1" }));
    backend("running", { workersDone: 0, workersTotal: 1 });
    const started = await useMissionsStore.getState().start("w", "m1");
    expect(started.status).toBe("running");
    const s = useMissionsStore.getState();
    expect(s.missions[0]).toMatchObject({ status: "running", activeRunId: "r1", workersTotal: 1 });
    expect(s.details.m1.mission.activeRunId).toBe("r1");
  });

  it("un provider que no corre sin terminal: el error sube y la lista igual se relee", async () => {
    m.startMission.mockRejectedValue("'bash' no se puede correr sin terminal: no puede ser lead");
    backend("draft");
    await expect(useMissionsStore.getState().start("w", "m1")).rejects.toMatch(/sin terminal/);
    expect(m.listMissions).toHaveBeenCalledTimes(1);
    expect(useMissionsStore.getState().missions[0].status).toBe("draft");
  });

  it("si el lead no arranca, se ve la misión failed", async () => {
    m.startMission.mockRejectedValue("no se pudo lanzar");
    backend("failed");
    await expect(useMissionsStore.getState().start("w", "m1")).rejects.toBeTruthy();
    expect(useMissionsStore.getState().details.m1.mission.status).toBe("failed");
  });

  it("cancel refleja cancelled", async () => {
    m.cancelMission.mockResolvedValue(mission({ status: "cancelled" }));
    backend("cancelled");
    await useMissionsStore.getState().cancel("w", "m1");
    expect(m.cancelMission).toHaveBeenCalledWith("m1");
    expect(useMissionsStore.getState().missions[0].status).toBe("cancelled");
  });

  it("retries the same failed mission and refreshes its new active execution", async () => {
    backend("failed");
    await useMissionsStore.getState().loadDetail("m1");
    const retried = mission({ status: "running", activeRunId: "r2" });
    m.startMission.mockResolvedValue(retried);
    m.listMissions.mockResolvedValue([summary({ status: "running", activeRunId: "r2" })]);
    m.getMission.mockResolvedValue({ ...detail(), mission: retried });
    await useMissionsStore.getState().start("w", "m1");
    expect(m.startMission).toHaveBeenCalledWith("m1");
    expect(m.createMission).not.toHaveBeenCalled();
    expect(useMissionsStore.getState().details.m1.mission).toMatchObject({ id: "m1", status: "running", activeRunId: "r2" });
  });

  it("loadDetail guarda el detalle por id", async () => {
    m.getMission.mockResolvedValue(detail({ status: "done" }));
    const d = await useMissionsStore.getState().loadDetail("m1");
    expect(d.mission.status).toBe("done");
    expect(useMissionsStore.getState().details.m1).toBe(d);
  });

  it("un evento de tarea actualiza el avance y el estado", async () => {
    backend("running", { workersDone: 1, workersTotal: 3 });
    await useMissionsStore.getState().onTaskChanged("w", "m1");
    backend("done", { workersDone: 3, workersTotal: 3 });
    await useMissionsStore.getState().onTaskChanged("w", "m1");
    const s = useMissionsStore.getState();
    expect(s.missions[0]).toMatchObject({ status: "done", workersDone: 3 });
    expect(s.details.m1.mission.status).toBe("done");
  });

  it("sin detalle abierto, un evento solo relee la lista", async () => {
    backend("running");
    await useMissionsStore.getState().onTaskChanged("w", null);
    expect(m.listMissions).toHaveBeenCalledTimes(1);
    expect(m.getMission).not.toHaveBeenCalled();
  });

  it("una ráfaga de eventos no dispara un viaje por evento", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    m.listMissions.mockImplementation(async () => {
      await gate;
      return [summary({ status: "running" })];
    });
    m.getMission.mockResolvedValue(detail({ status: "running" }));

    const store = useMissionsStore.getState();
    const calls = [store.onTaskChanged("w", "m1"), store.onTaskChanged("w", "m1"), store.onTaskChanged("w", "m1")];
    release();
    await Promise.all(calls);
    // Uno en vuelo y uno más por los que llegaron mientras tanto.
    expect(m.listMissions).toHaveBeenCalledTimes(2);
  });
});

describe("cc-mission-changed", () => {
  it("lo que otra ventana arrancó se ve en esta, con el detalle abierto", async () => {
    backend("draft");
    await useMissionsStore.getState().load("w");
    await useMissionsStore.getState().loadDetail("m1");

    // Otra ventana apretó "Iniciar": acá solo llega el evento.
    backend("running", { workersDone: 0, workersTotal: 1 });
    await useMissionsStore.getState().onMissionChanged("w", "m1", "m1");
    const s = useMissionsStore.getState();
    expect(s.missions[0]).toMatchObject({ status: "running", activeRunId: "r1" });
    expect(s.details.m1.mission.status).toBe("running");
    expect(m.startMission).not.toHaveBeenCalled();
  });

  it("una misión creada en otra ventana aparece en la lista", async () => {
    m.listMissions.mockResolvedValue([]);
    await useMissionsStore.getState().load("w");
    backend("draft");
    await useMissionsStore.getState().onMissionChanged("w", "m1", null);
    expect(useMissionsStore.getState().missions.map((x) => x.id)).toEqual(["m1"]);
    expect(m.getMission).not.toHaveBeenCalled();
  });

  it("si la que cambió no es la abierta, no se pide su detalle y el viejo se descarta", async () => {
    m.getMission.mockResolvedValue(detail({ status: "running", activeRunId: "r1" }));
    await useMissionsStore.getState().loadDetail("m1");
    m.getMission.mockClear();

    backend("done");
    await useMissionsStore.getState().onMissionChanged("w", "m1", "otra");
    expect(m.getMission).not.toHaveBeenCalledWith("m1");
    expect(useMissionsStore.getState().details.m1).toBeUndefined();
    expect(useMissionsStore.getState().missions[0].status).toBe("done");
  });
});
