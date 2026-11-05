import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { getSetting, setSetting } from "@/shared/ipc/settings";

import { chatThreadInterrupt } from "../structured/ipc";
import { threadKey } from "../structured/model";
import type { TimelineItem } from "../timeline/types";
import { chatTaskStop } from "./ipc";
import {
  applyTaskEvent, applyTaskItem, clearFinished, EMPTY_TASKS, markLost, parsePersisted, serializePersisted, stopRoute,
  type BgTask, type TaskEvent, type ThreadTasks,
} from "./tasksModel";

/**
 * As tarefas em segundo plano de cada conversa, pela chave dela (`thread:<id>`, a mesma do modelo unificado). Chegam
 * pelo evento `cc-chat-thread` (`task`, `taskItem`, `closed`) e ficam guardadas na tabela `settings` (sem tabela
 * nova), para sobreviver à troca de conversa e à reabertura do app. A transcrição dos subagentes fica só na memória.
 */
interface TasksState {
  byKey: Record<string, ThreadTasks>;
  /** Quando a última tarefa começou, por conversa: o botão do cabeçalho pisca (o painel não abre sozinho). */
  pulse: Record<string, number>;
}

export const useTasks = create<TasksState>(() => ({ byKey: {}, pulse: {} }));

/** A chave em `settings` (o KV que já existe). */
export const TASKS_SETTING = "chat.tasks";
/** Quanto esperar, depois da última mudança, para gravar. */
export const SAVE_DEBOUNCE_MS = 1_000;

export const tasksOf = (key: string | null | undefined): ThreadTasks => (key ? useTasks.getState().byKey[key] : undefined) ?? EMPTY_TASKS;

function patch(key: string, fn: (s: ThreadTasks) => ThreadTasks): void {
  useTasks.setState((s) => {
    const prev = s.byKey[key] ?? EMPTY_TASKS;
    const next = fn(prev);
    return next === prev ? s : { byKey: { ...s.byKey, [key]: next } };
  });
}

/** Um evento `task` de uma conversa. Um início novo faz o botão do cabeçalho piscar. */
export function receiveTask(threadId: string, event: TaskEvent, now = Date.now()): void {
  const key = threadKey(threadId);
  const isNew = event.op === "started" && !tasksOf(key).tasks[event.taskId];
  patch(key, (s) => applyTaskEvent(s, event));
  if (isNew) useTasks.setState((s) => ({ pulse: { ...s.pulse, [key]: now } }));
}

export function receiveTaskItem(threadId: string, parentToolUseId: string, item: TimelineItem): void {
  patch(threadKey(threadId), (s) => applyTaskItem(s, parentToolUseId, item));
}

/** A lixeira do painel: tira as concluídas desta conversa. */
export function clearFinishedTasks(key: string, derived: BgTask[]): void {
  patch(key, (s) => clearFinished(s, derived));
}

/**
 * O botão de parar de uma tarefa. Devolve o erro em texto (o painel mostra) ou `null`. O fim chega pelo evento: a
 * linha só muda quando o motor confirma.
 */
export async function stopTask(task: BgTask, threadId: string | null): Promise<string | null> {
  const route = stopRoute(task, threadId);
  try {
    if (route.kind === "task") await chatTaskStop(route.threadId, route.taskId);
    else if (route.kind === "thread") await chatThreadInterrupt(route.threadId);
    else return null;
    return null;
  } catch (e) {
    return String(e);
  }
}

// ── Guardar ──────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved: string | null = null;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const raw = serializePersisted(useTasks.getState().byKey);
    if (raw === lastSaved) return;
    lastSaved = raw;
    setSetting(TASKS_SETTING, raw).catch(() => { lastSaved = null; });
  }, SAVE_DEBOUNCE_MS);
}

/** Junta o que estava guardado ao que já chegou nesta abertura (o que chegou ganha: é mais novo). */
export function mergeLoaded(loaded: Record<string, ThreadTasks>): void {
  useTasks.setState((s) => {
    const byKey = { ...s.byKey };
    for (const [key, saved] of Object.entries(loaded)) {
      const now = byKey[key];
      if (!now) {
        byKey[key] = saved;
        continue;
      }
      const ids = saved.order.filter((id) => !now.tasks[id]);
      byKey[key] = {
        ...now,
        tasks: { ...Object.fromEntries(ids.map((id) => [id, saved.tasks[id]!])), ...now.tasks },
        order: [...ids, ...now.order],
        dismissed: [...new Set([...saved.dismissed, ...now.dismissed])],
      };
    }
    return { byKey };
  });
}

let started = false;

/** Liga a escuta e lê a lista guardada (uma vez por janela; idempotente). */
export function startTasks(): void {
  if (started) return;
  started = true;
  void getSetting(TASKS_SETTING)
    .then((raw) => {
      lastSaved = raw;
      mergeLoaded(parsePersisted(raw, Date.now()));
    })
    .catch(() => undefined);
  useTasks.subscribe((state, prev) => { if (state.byKey !== prev.byKey) scheduleSave(); });
  type Payload =
    | { type: "task"; threadId: string; task: TaskEvent }
    | { type: "taskItem"; threadId: string; parentToolUseId: string; item: TimelineItem }
    | { type: "closed"; threadId: string }
    | { type: string; threadId: string };
  void listen<Payload>("cc-chat-thread", (e) => {
    const p = e.payload;
    if (p.type === "task" && "task" in p) receiveTask(p.threadId, p.task);
    else if (p.type === "taskItem" && "item" in p) receiveTaskItem(p.threadId, p.parentToolUseId, p.item);
    // O processo fechou: o que rodava nele parou junto.
    else if (p.type === "closed") patch(threadKey(p.threadId), (s) => markLost(s, Date.now()));
  }).catch(() => undefined);
}

/** Só para os testes: volta ao começo. */
export function resetTasksForTest(): void {
  started = false;
  lastSaved = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  useTasks.setState({ byKey: {}, pulse: {} });
}
