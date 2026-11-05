import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invokeMock, useInvokeMock } from "@/test/invokeMock";

vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

import {
  clearFinishedTasks, mergeLoaded, receiveTask, receiveTaskItem, resetTasksForTest, SAVE_DEBOUNCE_MS, startTasks, stopTask, tasksOf,
  TASKS_SETTING, useTasks,
} from "../tasks/tasksStore";
import { EMPTY_TASKS, parsePersisted, type BgTask } from "../tasks/tasksModel";

useInvokeMock();

const running = (id: string, extra: Partial<BgTask> = {}): BgTask => ({
  id, toolUseId: null, parentId: null, kind: "shell", title: id, subagent: null, prompt: null, status: "running", startedAt: 1, endedAt: null,
  durationMs: null, summary: null, lastTool: null, background: true, stoppable: true, source: "events", ...extra,
});

beforeEach(() => resetTasksForTest());
afterEach(() => vi.useRealTimers());

describe("o parar de uma tarefa", () => {
  it("a do Claude vai ao chat_task_stop da conversa, e só a ela", async () => {
    invokeMock.once("chat_task_stop", () => undefined);
    expect(await stopTask(running("b1"), "th-1")).toBeNull();
    expect(invokeMock.calls("chat_task_stop")).toEqual([{ threadId: "th-1", taskId: "b1" }]);
    expect(invokeMock.calls("chat_thread_interrupt")).toEqual([]);
  });

  it("o integrante do time para o turno dele, não o desta conversa", async () => {
    invokeMock.once("chat_thread_interrupt", () => undefined);
    await stopTask(running("thread:th-9", { source: "team" }), "th-1");
    expect(invokeMock.calls("chat_thread_interrupt")).toEqual([{ threadId: "th-9" }]);
  });

  it("sem meio seguro, não chama nada", async () => {
    expect(await stopTask(running("t", { stoppable: false }), "th-1")).toBeNull();
    expect(await stopTask(running("t", { status: "completed" }), "th-1")).toBeNull();
  });

  it("o erro do backend volta em texto para o painel mostrar", async () => {
    invokeMock.once("chat_task_stop", () => { throw new Error("O processo do Claude desta conversa já fechou"); });
    expect(await stopTask(running("b1"), "th-1")).toContain("já fechou");
  });
});

describe("as tarefas por conversa", () => {
  it("o início novo pisca o botão; o repetido não", () => {
    receiveTask("th-1", { op: "started", taskId: "a", at: 1, title: "x" }, 500);
    expect(useTasks.getState().pulse["thread:th-1"]).toBe(500);
    receiveTask("th-1", { op: "started", taskId: "a", at: 1 }, 900);
    expect(useTasks.getState().pulse["thread:th-1"]).toBe(500);
    receiveTaskItem("th-1", "toolu", { kind: "assistant", id: "m", text: "ok" });
    expect(tasksOf("thread:th-1").transcripts.toolu).toHaveLength(1);
    // Outra conversa não vê nada.
    expect(tasksOf("thread:th-2")).toBe(EMPTY_TASKS);
  });

  it("a lixeira tira as concluídas só desta conversa", () => {
    receiveTask("th-1", { op: "started", taskId: "a", at: 1 });
    receiveTask("th-1", { op: "ended", taskId: "a", at: 2, status: "completed" });
    receiveTask("th-2", { op: "started", taskId: "b", at: 1 });
    receiveTask("th-2", { op: "ended", taskId: "b", at: 2, status: "failed" });
    clearFinishedTasks("thread:th-1", []);
    expect(tasksOf("thread:th-1").order).toEqual([]);
    expect(tasksOf("thread:th-2").order).toEqual(["b"]);
  });

  it("o guardado entra sem passar por cima do que já chegou", () => {
    receiveTask("th-1", { op: "started", taskId: "novo", at: 9 });
    mergeLoaded(parsePersisted(JSON.stringify({ v: 1, threads: { "thread:th-1": { tasks: [running("velho", { status: "completed", endedAt: 3 }), running("novo", { status: "completed", endedAt: 3 })], dismissed: [] } } }), 10));
    const s = tasksOf("thread:th-1");
    expect(s.order).toEqual(["velho", "novo"]);
    expect(s.tasks.novo!.status).toBe("running");
  });
});

describe("guardar entre aberturas", () => {
  it("lê uma vez ao ligar e grava uma vez depois da última mudança", async () => {
    vi.useFakeTimers();
    invokeMock.once("db_get_setting", () => null);
    invokeMock.on("db_set_setting", () => undefined);
    startTasks();
    startTasks();
    await vi.advanceTimersByTimeAsync(0);
    receiveTask("th-1", { op: "started", taskId: "a", at: 1, title: "x" });
    receiveTask("th-1", { op: "updated", taskId: "a", at: 2, summary: "y" });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(invokeMock.calls("db_set_setting")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const calls = invokeMock.calls("db_set_setting") as { key: string; value: string }[];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(TASKS_SETTING);
    expect(parsePersisted(calls[0]!.value, 5)["thread:th-1"]!.tasks.a).toMatchObject({ summary: "y", status: "lost" });
    // A transcrição não vai ao banco: mudar só ela não regrava.
    receiveTaskItem("th-1", "toolu", { kind: "assistant", id: "m", text: "ok" });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(invokeMock.calls("db_set_setting")).toHaveLength(1);
  });
});
