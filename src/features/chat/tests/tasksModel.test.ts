import { describe, expect, it } from "vitest";

import {
  applyTaskEvent, applyTaskItem, clearFinished, EMPTY_TASKS, elapsedMs, formatElapsed, markLost, parsePersisted, runningCount,
  serializePersisted, stopRoute, taskSections, tasksFromItems, visibleTasks, type BgTask, type TaskEvent, type ThreadTasks,
} from "../tasks/tasksModel";
import type { TimelineItem } from "../timeline/types";

const started = (taskId: string, extra: Partial<TaskEvent> = {}): TaskEvent =>
  ({ op: "started", taskId, kind: "shell", title: `tarefa ${taskId}`, status: "running", stoppable: true, background: true, at: 1_000, ...extra });

const feed = (events: TaskEvent[], from: ThreadTasks = EMPTY_TASKS) => events.reduce((s, e) => applyTaskEvent(s, e), from);

/** Um `t` de teste: devolve a chave com as variáveis, como o i18next faria com o catálogo. */
const t = (key: string, vars: Record<string, unknown> = {}) => {
  const tpl: Record<string, string> = { "chat.tasks.time.s": "{{s}} s", "chat.tasks.time.ms": "{{m}} min {{s}} s", "chat.tasks.time.hm": "{{h}} h {{m}} min" };
  return (tpl[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k]));
};

describe("a árvore de tarefas a partir dos eventos", () => {
  it("o início abre a tarefa rodando e o fim fecha com status, resumo e duração", () => {
    let s = feed([started("b1", { toolUseId: "toolu_b" })]);
    expect(s.order).toEqual(["b1"]);
    expect(s.tasks.b1).toMatchObject({ status: "running", startedAt: 1_000, endedAt: null, toolUseId: "toolu_b", stoppable: true });
    s = applyTaskEvent(s, { op: "ended", taskId: "b1", status: "completed", summary: "saiu 0", durationMs: 6_100, at: 7_200 });
    expect(s.tasks.b1).toMatchObject({ status: "completed", endedAt: 7_200, summary: "saiu 0", durationMs: 6_100 });
  });

  it("um início repetido (o Codex manda no started e no completed) não zera o relógio nem o status final", () => {
    let s = feed([started("a", { at: 100 }), { op: "ended", taskId: "a", status: "failed", at: 900 }]);
    s = applyTaskEvent(s, started("a", { at: 500, title: "outro nome" }));
    expect(s.tasks.a).toMatchObject({ startedAt: 100, status: "failed", title: "tarefa a" });
    expect(s.order).toEqual(["a"]);
  });

  it("o fim de uma tarefa que nunca começou aqui ainda aparece (o app abriu no meio)", () => {
    const s = applyTaskEvent(EMPTY_TASKS, { op: "ended", taskId: "x", status: "stopped", at: 50 });
    expect(s.tasks.x).toMatchObject({ status: "stopped", startedAt: 50, endedAt: 50, title: "" });
  });

  it("a atualização muda o título e o progresso sem mexer no status", () => {
    const s = feed([started("a"), { op: "updated", taskId: "a", title: "Novo", summary: "lendo", lastTool: "Read", at: 2_000 }]);
    expect(s.tasks.a).toMatchObject({ title: "Novo", summary: "lendo", lastTool: "Read", status: "running" });
  });

  it("o conjunto vivo encerra a tarefa em segundo plano que saiu dele, e não a de primeiro plano", () => {
    const s = feed([started("bg"), started("fg", { background: false, kind: "agent" }), { op: "live", taskId: "", live: [], at: 3_000 }]);
    expect(s.tasks.bg).toMatchObject({ status: "completed", endedAt: 3_000 });
    expect(s.tasks.fg!.status).toBe("running");
  });

  it("o processo que fechou deixa as que rodavam como interrompidas", () => {
    const s = markLost(feed([started("a"), started("b"), { op: "ended", taskId: "b", status: "completed", at: 2 }]), 9_000);
    expect(s.tasks.a).toMatchObject({ status: "lost", endedAt: 9_000 });
    expect(s.tasks.b!.status).toBe("completed");
  });

  it("os filhos ficam debaixo do pai; o pai sem registro vira raiz", () => {
    const s = feed([started("pai", { kind: "agent" }), started("f1", { parentTaskId: "pai" }), started("f2", { parentTaskId: "pai" }), started("orfao", { parentTaskId: "sumiu" })]);
    const { running } = taskSections(visibleTasks(s, []));
    expect(running.map((n) => n.task.id)).toEqual(["pai", "orfao"]);
    expect(running[0]!.children.map((n) => n.task.id)).toEqual(["f1", "f2"]);
  });

  it("concluídas vão para a seção de baixo, a mais recente primeiro", () => {
    const s = feed([started("a"), started("b"), started("c"), { op: "ended", taskId: "a", status: "completed", at: 5 }, { op: "ended", taskId: "c", status: "failed", at: 9 }]);
    const { running, done } = taskSections(visibleTasks(s, []));
    expect(running.map((n) => n.task.id)).toEqual(["b"]);
    expect(done.map((n) => n.task.id)).toEqual(["c", "a"]);
    expect(runningCount(visibleTasks(s, []))).toBe(1);
  });

  it("o que o subagente faz vira a transcrição da tarefa, atualizada no lugar", () => {
    let s = applyTaskItem(EMPTY_TASKS, "toolu_a", { kind: "tool", id: "r1", name: "Read", status: "running" });
    s = applyTaskItem(s, "toolu_a", { kind: "tool", id: "r1", name: "Read", status: "done" });
    s = applyTaskItem(s, "toolu_a", { kind: "assistant", id: "m1", text: "ok" });
    expect(s.transcripts.toolu_a!.map((i) => `${i.id}:${i.status ?? i.text}`)).toEqual(["r1:done", "m1:ok"]);
  });
});

describe("as tarefas que saem da timeline (motores sem eventos de tarefa)", () => {
  const items: TimelineItem[] = [
    { kind: "user", id: "u", text: "oi", at: 1 },
    { kind: "tool", id: "t1", tool: "task", name: "Task", label: "Revisar o diff", status: "running", at: 10 },
    { kind: "tool", id: "t2", tool: "task", name: "Task", label: "Ler docs", status: "done", at: 20, durationMs: 3_000, output: "pronto" },
    { kind: "tool", id: "c", tool: "command", name: "Bash", label: "ls", status: "done", at: 30 },
  ];

  it("cada ferramenta de subagente vira uma tarefa que não se para daqui", () => {
    const list = tasksFromItems(items);
    expect(list.map((x) => [x.id, x.status, x.title, x.source, x.stoppable])).toEqual([
      ["t1", "running", "Revisar o diff", "items", false],
      ["t2", "completed", "Ler docs", "items", false],
    ]);
    expect(list[1]).toMatchObject({ endedAt: 3_020, durationMs: 3_000, summary: "pronto" });
  });

  it("a tarefa por evento cobre a mesma ferramenta (o mesmo tool_use_id)", () => {
    const s = feed([started("k", { toolUseId: "t1", kind: "agent" })]);
    expect(visibleTasks(s, tasksFromItems(items)).map((x) => x.id)).toEqual(["k", "t2"]);
  });
});

describe("limpar as concluídas", () => {
  it("tira as concluídas (e a transcrição delas), mas não o filho concluído de um pai que ainda roda", () => {
    let s = feed([
      started("pai", { kind: "agent", toolUseId: "tp" }), started("filho", { parentTaskId: "pai" }), started("solta", { toolUseId: "ts" }),
      { op: "ended", taskId: "filho", status: "completed", at: 5 }, { op: "ended", taskId: "solta", status: "failed", at: 6 },
    ]);
    s = applyTaskItem(s, "ts", { kind: "assistant", id: "m", text: "x" });
    const derived: BgTask[] = tasksFromItems([{ kind: "tool", id: "d1", tool: "task", label: "antiga", status: "done", at: 1 }]);
    const cleared = clearFinished(s, derived);
    expect(cleared.order).toEqual(["pai", "filho"]);
    expect(cleared.transcripts.ts).toBeUndefined();
    expect(cleared.dismissed).toEqual(["d1"]);
    expect(visibleTasks(cleared, derived).map((x) => x.id)).toEqual(["pai", "filho"]);
  });

  it("sem concluídas, o estado é o mesmo objeto (nada a regravar)", () => {
    const s = feed([started("a")]);
    expect(clearFinished(s, [])).toBe(s);
  });
});

describe("o tempo decorrido", () => {
  it("formata como o Claude Code: segundos, minutos e segundos, horas e minutos", () => {
    expect(formatElapsed(10_400, t)).toBe("10 s");
    expect(formatElapsed(559_000, t)).toBe("9 min 19 s");
    expect(formatElapsed(3_600_000 + 5 * 60_000 + 59_000, t)).toBe("1 h 5 min");
    expect(formatElapsed(-50, t)).toBe("0 s");
  });

  it("a que roda conta até agora; a que acabou usa a duração do agente ou o fim", () => {
    const run = { startedAt: 1_000, endedAt: null, durationMs: null } as BgTask;
    expect(elapsedMs(run, 11_000)).toBe(10_000);
    expect(elapsedMs({ ...run, endedAt: 4_000 }, 99_000)).toBe(3_000);
    expect(elapsedMs({ ...run, endedAt: 4_000, durationMs: 2_500 }, 99_000)).toBe(2_500);
  });
});

describe("para onde vai o botão de parar", () => {
  const base = feed([started("b1", { toolUseId: "tb" })]).tasks.b1!;

  it("a tarefa do Claude rodando vai ao stop_task da conversa", () => {
    expect(stopRoute(base, "th-1")).toEqual({ kind: "task", threadId: "th-1", taskId: "b1" });
  });

  it("o integrante do time para só o turno dele", () => {
    expect(stopRoute({ ...base, source: "team", id: "thread:th-9", stoppable: true }, "th-1")).toEqual({ kind: "thread", threadId: "th-9" });
  });

  it("sem meio seguro, o botão fica desligado com o motivo", () => {
    expect(stopRoute({ ...base, status: "completed" }, "th-1")).toEqual({ kind: "none", reason: "finished" });
    expect(stopRoute({ ...base, stoppable: false }, "th-1")).toEqual({ kind: "none", reason: "engine" });
    expect(stopRoute({ ...base, source: "items", stoppable: false }, "th-1")).toEqual({ kind: "none", reason: "engine" });
    expect(stopRoute(base, null)).toEqual({ kind: "none", reason: "engine" });
  });
});

describe("a lista guardada", () => {
  it("volta ao reabrir o app, com as que rodavam como interrompidas e sem transcrição", () => {
    let s = feed([started("a"), started("b"), { op: "ended", taskId: "b", status: "completed", at: 3 }]);
    s = applyTaskItem(s, "x", { kind: "assistant", id: "m", text: "x" });
    const raw = serializePersisted({ "thread:1": s });
    const back = parsePersisted(raw, 50_000)["thread:1"]!;
    expect(back.order).toEqual(["a", "b"]);
    expect(back.tasks.a).toMatchObject({ status: "lost", endedAt: 50_000 });
    expect(back.tasks.b!.status).toBe("completed");
    expect(back.transcripts).toEqual({});
  });

  it("lixo ou versão desconhecida não derrubam nada", () => {
    expect(parsePersisted(null, 1)).toEqual({});
    expect(parsePersisted("{quebrado", 1)).toEqual({});
    expect(parsePersisted(JSON.stringify({ v: 99, threads: { a: {} } }), 1)).toEqual({});
    expect(parsePersisted(JSON.stringify({ v: 1, threads: { a: { tasks: [{ id: 3 }], dismissed: "x" } } }), 1)).toEqual({ a: { ...EMPTY_TASKS } });
  });
});
