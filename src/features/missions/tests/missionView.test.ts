import { describe, expect, it } from "vitest";

import type { PendingApproval, Task, TaskStatus } from "@/features/runs/types";

import {
  agentStateOf, approvalsFor, blockedRuns, canEdit, countAgentStates, dependencyLabels, emptyForm, formFromMission,
  missingFields, missionAction, missionPhase, parseBudget, progressOf, switchExecutionMode, toInput, workersOf,
} from "../missionView";
import type { Mission, MissionStatus } from "../types";

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    runId: "r",
    title: "una tarea",
    prompt: "hacé algo",
    agentId: "claude-code",
    accountId: null,
    model: null,
    cwd: "/tmp/proy",
    budgetUsd: null,
    status: "running" as TaskStatus,
    sessionId: null,
    attempt: 1,
    result: null,
    error: null,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    eventsPath: null,
    worktreePath: null,
    branch: null,
    worktreeRemoved: false,
    complexity: null,
    routedBy: null,
    routeNote: null,
    role: null,
    planKey: null,
    parentId: null,
    depth: 0,
    isolate: false,
    resultSchema: null,
    lastError: null,
    handoff: null,
    dependsOn: [],
    startedAt: null,
    endedAt: null,
    createdAt: 0,
    ...patch,
  };
}

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    workspaceId: "w",
    title: "Hola",
    objective: "Crear hello.txt",
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

describe("missionAction / canEdit", () => {
  it("un borrador se arranca y se edita", () => {
    expect(missionAction("draft")).toBe("start");
    expect(canEdit("draft")).toBe(true);
  });

  it("una que corre solo se cancela", () => {
    expect(missionAction("running")).toBe("cancel");
    expect(canEdit("running")).toBe(false);
  });

  it("offers a new attempt for a failed mission without changing its configuration", () => {
    expect(missionAction("failed")).toBe("retry");
    expect(canEdit("failed")).toBe(false);
  });

  it("una concluida o cancelada no ofrece ninguna acción", () => {
    for (const s of ["done", "done_without_delivery", "cancelled"] as MissionStatus[]) {
      expect(missionAction(s)).toBeNull();
      expect(canEdit(s)).toBe(false);
    }
  });

  it("keeps a terminal completion without delivery in its own final phase", () => {
    expect(missionPhase("done_without_delivery", true)).toBe("done_without_delivery");
  });
});

describe("progressOf", () => {
  it("un borrador no tiene avance que mostrar", () => {
    expect(progressOf({ workersDone: 0, workersTotal: 0, leadStatus: null })).toBeNull();
  });

  it("sin workers todavía, el lead está planificando", () => {
    for (const leadStatus of ["pending", "ready", "running"] as TaskStatus[]) {
      expect(progressOf({ workersDone: 0, workersTotal: 0, leadStatus })).toEqual({ kind: "planning" });
    }
  });

  it("el lead no cuenta: el avance es de los workers", () => {
    expect(progressOf({ workersDone: 1, workersTotal: 2, leadStatus: "running" }))
      .toEqual({ kind: "workers", done: 1, total: 2 });
  });

  it("terminada: los workers completados sobre el total", () => {
    expect(progressOf({ workersDone: 2, workersTotal: 2, leadStatus: "done" }))
      .toEqual({ kind: "workers", done: 2, total: 2 });
  });

  it("un lead que terminó sin repartir no queda 'planificando'", () => {
    expect(progressOf({ workersDone: 0, workersTotal: 0, leadStatus: "failed" })).toBeNull();
  });

  it("workersOf deja afuera al lead", () => {
    const lead = { id: "l", role: "lead" } as Task;
    const w = { id: "w", role: "worker" } as Task;
    const manual = { id: "m", role: null } as Task;
    expect(workersOf([lead, w, manual]).map((t) => t.id)).toEqual(["w", "m"]);
  });
});

describe("estado de los agentes", () => {
  it("mapea cada estado de tarea", () => {
    const cases: Array<[TaskStatus, string]> = [
      ["ready", "working"], ["running", "working"], ["pending", "queued"], ["done", "done"],
      ["failed", "failed"], ["skipped", "failed"], ["cancelled", "stopped"], ["handed_off", "stopped"],
    ];
    for (const [status, state] of cases) expect(agentStateOf(task({ id: "t", status }))).toBe(state);
  });

  it("cuenta por estado", () => {
    const counts = countAgentStates([
      task({ id: "a", status: "running" }), task({ id: "b", status: "pending" }),
      task({ id: "c", status: "pending" }), task({ id: "d", status: "done" }),
    ]);
    expect(counts).toEqual({ working: 1, waiting_approval: 0, waiting_deps: 0, queued: 2, done: 1, failed: 0, stopped: 0 });
  });

  it("nombra las dependencias por su clave del plan", () => {
    const tasks = [
      task({ id: "a", planKey: "tests" }),
      task({ id: "b", title: "sin clave" }),
      task({ id: "c", dependsOn: ["a", "b", "desconocida-123"] }),
    ];
    expect(dependencyLabels(tasks[2], tasks)).toEqual(["tests", "sin clave", "desconoc"]);
  });
});

describe("permisos en la misión", () => {
  const approval = (id: string, taskId: string, askedAt = 0): PendingApproval => ({
    id, taskId, toolName: "Bash", input: { command: "ls" }, askedAt, suggestedRule: null,
  });

  it("una tarea con un permiso esperando está bloqueada, no trabajando", () => {
    const t1 = task({ id: "t1", status: "running" });
    expect(agentStateOf(t1, [t1], new Set(["t1"]))).toBe("waiting_approval");
    expect(agentStateOf(t1, [t1])).toBe("working");
  });

  it("una pendiente distingue esperar dependencias de esperar lugar", () => {
    const a = task({ id: "a", status: "running" });
    const b = task({ id: "b", status: "pending", dependsOn: ["a"] });
    const c = task({ id: "c", status: "pending" });
    expect(agentStateOf(b, [a, b, c])).toBe("waiting_deps");
    expect(agentStateOf(c, [a, b, c])).toBe("queued");
    expect(agentStateOf(b, [{ ...a, status: "done" }, b])).toBe("queued");
  });

  it("filtra la cola de la flota a las tareas de la misión, la más vieja primero", () => {
    const mine = [task({ id: "t1" }), task({ id: "t2" })];
    const queue = [approval("x", "otra"), approval("b", "t2", 5), approval("a", "t1", 1)];
    expect(approvalsFor(queue, mine).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("sabe qué runs tienen a alguien esperando", () => {
    const tasks = [task({ id: "t1", runId: "r1" }), task({ id: "t2", runId: "r2" })];
    expect([...blockedRuns([approval("a", "t2")], tasks)]).toEqual(["r2"]);
    expect(blockedRuns([], tasks).size).toBe(0);
  });

  it("una misión en curso que espera se muestra así, sin cambiar su estado", () => {
    expect(missionPhase("running", true)).toBe("waiting_approval");
    expect(missionPhase("running", false)).toBe("running");
    expect(missionPhase("done", true)).toBe("done");
  });

  it("decidir saca el bloqueo: sin el permiso, vuelve a trabajando", () => {
    const t1 = task({ id: "t1", status: "running" });
    const queue = [approval("a", "t1")];
    const before = new Set(approvalsFor(queue, [t1]).map((a) => a.taskId));
    expect(countAgentStates([t1], before).waiting_approval).toBe(1);
    const after = new Set(approvalsFor([], [t1]).map((a) => a.taskId));
    expect(countAgentStates([t1], after)).toMatchObject({ waiting_approval: 0, working: 1 });
  });
});

describe("formulario", () => {
  it("un borrador nuevo va por complejidad con cuenta automática", () => {
    const form = emptyForm("/tmp/proy");
    expect(form.mode).toBe("hard");
    expect(form.autoAccount).toBe(true);
    expect(missingFields(form)).toEqual(["title", "objective"]);
  });

  it("marca lo que falta para guardar", () => {
    expect(missingFields({ ...emptyForm(" "), title: "x" })).toEqual(["objective", "cwd"]);
  });

  it("con complejidad no fija agente ni modelo", () => {
    const input = toInput({ ...emptyForm("/p"), title: " Hola ", objective: " obj ", mode: "trivial", model: "opus" });
    expect(input).toMatchObject({
      title: "Hola", objective: "obj", cwd: "/p", complexity: "trivial", leadAgentId: null, leadModel: null,
    });
  });

  it("con modelo fijo manda agente y modelo, sin complejidad", () => {
    const input = toInput({ ...emptyForm("/p"), title: "t", objective: "o", mode: "fixed", executionMode: "specific", agentId: "codex", model: "gpt-5" });
    expect(input).toMatchObject({ complexity: null, leadAgentId: "codex", leadModel: "gpt-5" });
  });

  it("con cuenta automática nunca manda una cuenta elegida", () => {
    const auto = toInput({ ...emptyForm("/p"), autoAccount: true, accountId: "acc-1" });
    expect(auto.leadAccountId).toBeNull();
    const chosen = toInput({ ...emptyForm("/p"), executionMode: "specific", mode: "fixed", autoAccount: false, accountId: "acc-1" });
    expect(chosen).toMatchObject({ autoAccount: false, leadAccountId: "acc-1" });
  });

  it("el presupuesto vacío o no positivo es sin tope", () => {
    expect(parseBudget("")).toBeNull();
    expect(parseBudget("0")).toBeNull();
    expect(parseBudget("abc")).toBeNull();
    expect(parseBudget("1,5")).toBe(1.5);
  });

  it("vuelve a armar el formulario desde una misión guardada", () => {
    const fixed = formFromMission(mission({ leadAgentId: "codex", leadModel: "gpt-5", complexity: null, budgetUsd: 2 }));
    expect(fixed).toMatchObject({ mode: "fixed", agentId: "codex", model: "gpt-5", budget: "2" });
    const routed = formFromMission(mission({ complexity: "standard" }));
    expect(routed).toMatchObject({ mode: "standard", agentId: "claude-code", model: null, budget: "" });
    expect(toInput(formFromMission(mission()))).toMatchObject({ complexity: "hard", autoAccount: true });
  });

  it("keeps Automatic, Specific and Squad mutually exclusive in the payload", () => {
    const automatic = { ...emptyForm("/p"), title: "t", objective: "o", agentId: "codex", model: "gpt-5" };
    const squadDraft = switchExecutionMode(automatic, "squad");
    const squad = { ...squadDraft, squadId: "squad-1" };
    expect(toInput(squad)).toMatchObject({
      squadId: "squad-1", leadAgentId: null, leadModel: null, leadAccountId: null, autoAccount: true, complexity: null,
    });

    const backToAutomatic = switchExecutionMode(squad, "automatic");
    expect(backToAutomatic.squadId).toBeNull();
    expect(toInput(backToAutomatic)).toMatchObject({ squadId: null, leadAgentId: null, leadModel: null, complexity: "hard" });

    const specific = switchExecutionMode(squad, "specific");
    expect(specific.squadId).toBeNull();
    expect(toInput(specific)).toMatchObject({ squadId: null, leadAgentId: "codex", leadModel: "gpt-5", complexity: null });
  });

  it("preserves manual choices while Specific stays selected and clears account on mode change", () => {
    const specific = switchExecutionMode(emptyForm("/p"), "specific");
    const selected = { ...specific, agentId: "codex", model: "gpt-5", autoAccount: false, accountId: "work-account" };
    expect(switchExecutionMode(selected, "specific")).toMatchObject(selected);
    const automatic = switchExecutionMode(selected, "automatic");
    expect(automatic).toMatchObject({ squadId: null, autoAccount: true, accountId: null });
    expect(toInput(automatic)).toMatchObject({ leadAgentId: null, leadModel: null, leadAccountId: null, autoAccount: true });
  });
});
