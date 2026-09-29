import { describe, expect, it } from "vitest";

import type { Task, TaskStatus } from "@/features/runs/types";

import {
  agentStateOf, canEdit, countAgentStates, dependencyLabels, emptyForm, formFromMission, missingFields,
  missionAction, parseBudget, progressOf, toInput,
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

  it("una terminada no ofrece ninguna acción", () => {
    for (const s of ["done", "failed", "cancelled"] as MissionStatus[]) {
      expect(missionAction(s)).toBeNull();
      expect(canEdit(s)).toBe(false);
    }
  });
});

describe("progressOf", () => {
  it("sin tareas no hay avance que mostrar", () => {
    expect(progressOf({ tasksDone: 0, tasksTotal: 0 })).toBeNull();
  });

  it("cuenta las listas sobre el total", () => {
    expect(progressOf({ tasksDone: 3, tasksTotal: 5 })).toEqual({ done: 3, total: 5 });
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
    expect(counts).toEqual({ working: 1, queued: 2, done: 1, failed: 0, stopped: 0 });
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
    const input = toInput({ ...emptyForm("/p"), title: "t", objective: "o", mode: "fixed", agentId: "codex", model: "gpt-5" });
    expect(input).toMatchObject({ complexity: null, leadAgentId: "codex", leadModel: "gpt-5" });
  });

  it("con cuenta automática nunca manda una cuenta elegida", () => {
    const auto = toInput({ ...emptyForm("/p"), autoAccount: true, accountId: "acc-1" });
    expect(auto.leadAccountId).toBeNull();
    const chosen = toInput({ ...emptyForm("/p"), autoAccount: false, accountId: "acc-1" });
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
    expect(routed).toMatchObject({ mode: "standard", agentId: "claude-code", model: "", budget: "" });
    expect(toInput(formFromMission(mission()))).toMatchObject({ complexity: "hard", autoAccount: true });
  });
});
