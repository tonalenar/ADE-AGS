import type { TimelineItem } from "../timeline/types";

/**
 * As tarefas em segundo plano de uma conversa (o painel "Tarefas em segundo plano", como o do Claude Code): os
 * subagentes e os shells que o agente deixou rodando, em árvore. Tudo puro, para testar sem tela.
 *
 * De onde vêm:
 * - `events`: os eventos `task` do backend (`src-tauri/src/conversa/tarefas.rs`). O Claude Code manda
 *   `task_started`/`task_updated`/`task_notification`/`background_tasks_changed`; o Codex, os itens
 *   `collabAgentToolCall` e `subAgentActivity`. O que um subagente do Claude faz chega como `taskItem`.
 * - `items`: os motores sem evento de tarefa (OpenCode, Cursor, Antigravity) só mostram o subagente como a ferramenta
 *   `task` da timeline, que já está no banco: a tarefa sai dela.
 * - `team`: um integrante do time trabalhando para esta conversa.
 */
export type TaskStatus = "running" | "completed" | "failed" | "stopped" | "lost";
export type TaskKind = "shell" | "agent" | "other";
export type TaskSource = "events" | "items" | "team";

export interface BgTask {
  id: string;
  /** A ferramenta que lançou a tarefa (o `tool_use_id` do Claude, o item do Codex). */
  toolUseId: string | null;
  /** A tarefa que lançou esta (um subagente dentro de outro). */
  parentId: string | null;
  kind: TaskKind;
  title: string;
  /** O tipo do subagente (`general-purpose`…). */
  subagent: string | null;
  prompt: string | null;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
  /** A duração que o próprio agente mediu (melhor que o relógio da janela). */
  durationMs: number | null;
  summary: string | null;
  lastTool: string | null;
  /** Registrada em segundo plano (sai do conjunto vivo quando acaba). */
  background: boolean;
  /** O motor tem como parar só esta tarefa (o `stop_task` do Claude). */
  stoppable: boolean;
  source: TaskSource;
}

/** Um evento `task` do backend (espelho de `conversa::tarefas`). */
export interface TaskEvent {
  op: "started" | "updated" | "ended" | "live";
  taskId: string;
  at: number;
  toolUseId?: string;
  parentTaskId?: string;
  kind?: TaskKind;
  title?: string;
  subagent?: string;
  prompt?: string;
  status?: Exclude<TaskStatus, "lost">;
  summary?: string;
  lastTool?: string;
  durationMs?: number;
  tokens?: number;
  toolUses?: number;
  background?: boolean;
  stoppable?: boolean;
  /** `live`: os ids das tarefas em segundo plano ainda vivas. */
  live?: string[];
}

/** As tarefas de uma conversa. `transcripts` é por `toolUseId` (o que o subagente faz); `dismissed`, as tiradas da timeline. */
export interface ThreadTasks {
  tasks: Record<string, BgTask>;
  order: string[];
  transcripts: Record<string, TimelineItem[]>;
  dismissed: string[];
}

export const EMPTY_TASKS: ThreadTasks = { tasks: {}, order: [], transcripts: {}, dismissed: [] };

/** Quantas tarefas guardar por conversa e quantos itens de transcrição por tarefa. */
export const MAX_TASKS = 200;
export const MAX_TRANSCRIPT = 300;

const isFinished = (status: TaskStatus) => status !== "running";

function blank(id: string, at: number): BgTask {
  return {
    id, toolUseId: null, parentId: null, kind: "other", title: "", subagent: null, prompt: null, status: "running",
    startedAt: at, endedAt: null, durationMs: null, summary: null, lastTool: null, background: false, stoppable: false, source: "events",
  };
}

function put(state: ThreadTasks, task: BgTask): ThreadTasks {
  const order = state.order.includes(task.id) ? state.order : [...state.order, task.id];
  const tasks = { ...state.tasks, [task.id]: task };
  // Passou do teto: sai a concluída mais antiga.
  if (order.length <= MAX_TASKS) return { ...state, tasks, order };
  const drop = order.find((id) => isFinished(tasks[id]!.status) && id !== task.id);
  if (!drop) return { ...state, tasks, order };
  const { [drop]: _gone, ...rest } = tasks;
  return { ...state, tasks: rest, order: order.filter((id) => id !== drop) };
}

/** O que só se preenche quando veio (um evento não apaga o que outro já disse). */
function fill(task: BgTask, ev: TaskEvent): BgTask {
  return {
    ...task,
    ...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}),
    ...(ev.parentTaskId ? { parentId: ev.parentTaskId } : {}),
    ...(ev.subagent ? { subagent: ev.subagent } : {}),
    ...(ev.prompt ? { prompt: ev.prompt } : {}),
    ...(ev.summary ? { summary: ev.summary } : {}),
    ...(ev.lastTool ? { lastTool: ev.lastTool } : {}),
    ...(typeof ev.durationMs === "number" ? { durationMs: ev.durationMs } : {}),
  };
}

/** O estado depois de um evento `task`. Pura. */
export function applyTaskEvent(state: ThreadTasks, ev: TaskEvent): ThreadTasks {
  if (ev.op === "live") {
    const live = new Set(ev.live ?? []);
    let next = state;
    for (const id of state.order) {
      const task = next.tasks[id]!;
      // Uma tarefa em segundo plano que saiu do conjunto acabou; o aviso de fim, se vier depois, acerta o status.
      if (task.status === "running" && task.background && task.source === "events" && !live.has(id)) {
        next = put(next, { ...task, status: "completed", endedAt: ev.at });
      }
    }
    return next;
  }
  if (!ev.taskId) return state;
  const known = state.tasks[ev.taskId];
  if (ev.op === "started") {
    if (known) {
      // O mesmo início de novo (o Codex manda no `item/started` e no `item/completed`): só completa o que faltava.
      const task = fill({ ...known, title: known.title || ev.title || "" }, ev);
      return put(state, ev.status && isFinished(ev.status) && !isFinished(known.status) ? { ...task, status: ev.status, endedAt: ev.at } : task);
    }
    const task = fill({
      ...blank(ev.taskId, ev.at), kind: ev.kind ?? "other", title: ev.title ?? "", background: ev.background ?? false,
      stoppable: ev.stoppable ?? false, status: ev.status ?? "running",
    }, ev);
    return put(state, isFinished(task.status) ? { ...task, endedAt: ev.at } : task);
  }
  const base = known ?? blank(ev.taskId, ev.at);
  if (ev.op === "updated") {
    return put(state, fill({ ...base, ...(ev.title ? { title: ev.title } : {}) }, ev));
  }
  // `ended`: o aviso de fim sempre manda (corrige o "concluída" que o conjunto vivo supôs).
  return put(state, fill({ ...base, status: ev.status ?? "completed", endedAt: ev.at }, ev));
}

/** Um item do que um subagente faz (`taskItem`), na transcrição da tarefa dele; o mesmo id atualiza no lugar. Pura. */
export function applyTaskItem(state: ThreadTasks, parentToolUseId: string, item: TimelineItem): ThreadTasks {
  const list = state.transcripts[parentToolUseId] ?? [];
  const at = list.findIndex((i) => i.id === item.id);
  const next = at >= 0 ? list.map((i, k) => (k === at ? item : i)) : [...list, item].slice(-MAX_TRANSCRIPT);
  return { ...state, transcripts: { ...state.transcripts, [parentToolUseId]: next } };
}

/** O processo do agente fechou: o que rodava parou sem aviso de fim. Pura. */
export function markLost(state: ThreadTasks, at: number): ThreadTasks {
  let next = state;
  for (const id of state.order) {
    const task = next.tasks[id]!;
    if (task.status === "running" && task.source === "events") next = put(next, { ...task, status: "lost", endedAt: at });
  }
  return next;
}

const TOOL_STATUS: Record<string, TaskStatus> = { running: "running", done: "completed", error: "failed", denied: "stopped" };

/** As tarefas que saem da timeline: cada ferramenta `task` (o subagente do OpenCode, do Cursor, do Antigravity). Pura. */
export function tasksFromItems(items: TimelineItem[]): BgTask[] {
  return items.filter((i) => i.kind === "tool" && i.tool === "task").map((i) => {
    const status = TOOL_STATUS[i.status ?? "running"] ?? "running";
    const startedAt = i.at ?? 0;
    const durationMs = typeof i.durationMs === "number" ? i.durationMs : null;
    return {
      ...blank(i.id, startedAt), toolUseId: i.id, kind: "agent" as const, title: i.label ?? i.name ?? "", status, source: "items" as const,
      endedAt: isFinished(status) ? startedAt + (durationMs ?? 0) : null, durationMs, summary: i.output ?? null,
    };
  });
}

/** A lista do painel: as do backend, mais as da timeline que nenhuma delas cobre, menos as que a pessoa limpou. Pura. */
export function visibleTasks(state: ThreadTasks, derived: BgTask[], extra: BgTask[] = []): BgTask[] {
  const fromEvents = state.order.map((id) => state.tasks[id]).filter((t): t is BgTask => !!t);
  const covered = new Set(fromEvents.map((t) => t.toolUseId).filter((id): id is string => !!id));
  const hidden = new Set(state.dismissed);
  const fromItems = derived.filter((t) => !covered.has(t.id) && !hidden.has(t.id));
  return [...fromEvents, ...fromItems, ...extra.filter((t) => !hidden.has(t.id))];
}

export interface TaskNode {
  task: BgTask;
  children: TaskNode[];
}

/**
 * As duas seções do painel: "Em execução" (na ordem em que começaram) e "Concluído" (a mais recente primeiro), cada
 * raiz com os filhos debaixo. Um filho cujo pai não está na lista vira raiz. Pura.
 */
export function taskSections(tasks: BgTask[]): { running: TaskNode[]; done: TaskNode[] } {
  const ids = new Set(tasks.map((t) => t.id));
  const nodes = new Map(tasks.map((t) => [t.id, { task: t, children: [] as TaskNode[] }]));
  const roots: TaskNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    const parent = task.parentId && task.parentId !== task.id && ids.has(task.parentId) ? nodes.get(task.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const running = roots.filter((n) => n.task.status === "running");
  const done = roots.filter((n) => n.task.status !== "running").sort((a, b) => (b.task.endedAt ?? 0) - (a.task.endedAt ?? 0));
  return { running, done };
}

export const runningCount = (tasks: BgTask[]): number => tasks.filter((t) => t.status === "running").length;

/** Os ids das tarefas que têm um ancestral rodando (os filhos dele ficam, mesmo concluídos). */
function underRunning(tasks: BgTask[]): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const keep = new Set<string>();
  for (const task of tasks) {
    let parent = task.parentId ? byId.get(task.parentId) : undefined;
    const seen = new Set<string>();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (parent.status === "running") {
        keep.add(task.id);
        break;
      }
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
  }
  return keep;
}

/**
 * A lixeira do painel: tira as concluídas (e a transcrição delas); as que vêm da timeline ficam marcadas como
 * tiradas. O filho concluído de um pai que ainda roda fica (o "2 tarefas" do pai continua certo). Pura.
 */
export function clearFinished(state: ThreadTasks, derived: BgTask[], extra: BgTask[] = []): ThreadTasks {
  const all = visibleTasks(state, derived, extra);
  const keep = underRunning(all);
  const gone = all.filter((t) => isFinished(t.status) && !keep.has(t.id));
  if (gone.length === 0) return state;
  const goneIds = new Set(gone.map((t) => t.id));
  const tasks = { ...state.tasks };
  const transcripts = { ...state.transcripts };
  for (const id of goneIds) {
    const task = tasks[id];
    if (!task) continue;
    if (task.toolUseId) delete transcripts[task.toolUseId];
    delete tasks[id];
  }
  const extraDismissed = gone.filter((t) => t.source !== "events" && !state.dismissed.includes(t.id)).map((t) => t.id);
  return { tasks, order: state.order.filter((id) => !goneIds.has(id)), transcripts, dismissed: [...state.dismissed, ...extraDismissed] };
}

/** Quanto a tarefa durou (ou dura até `now`). Pura. */
export function elapsedMs(task: Pick<BgTask, "startedAt" | "endedAt" | "durationMs">, now: number): number {
  if (task.endedAt !== null) return task.durationMs ?? Math.max(0, task.endedAt - task.startedAt);
  return Math.max(0, now - task.startedAt);
}

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** "10 s", "9 min 19 s", "1 h 5 min", como o painel do Claude Code. Pura. */
export function formatElapsed(ms: number, t: Translate): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t("chat.tasks.time.hm", { h, m });
  if (m > 0) return t("chat.tasks.time.ms", { m, s });
  return t("chat.tasks.time.s", { s });
}

export type StopRoute =
  | { kind: "task"; threadId: string; taskId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "none"; reason: "finished" | "engine" };

/**
 * O que o botão de parar faz: a tarefa do Claude vai ao `stop_task` da conversa (só ela para); o integrante do time
 * para só o turno dele; o resto (o motor não tem como parar uma tarefa só) fica desligado, com o motivo. Nunca para a
 * conversa inteira. Pura.
 */
export function stopRoute(task: BgTask, threadId: string | null): StopRoute {
  if (task.status !== "running") return { kind: "none", reason: "finished" };
  if (task.source === "team" && task.id.startsWith("thread:")) return { kind: "thread", threadId: task.id.slice("thread:".length) };
  if (task.source === "events" && task.stoppable && threadId) return { kind: "task", threadId, taskId: task.id };
  return { kind: "none", reason: "engine" };
}

// ── Guardar entre aberturas ──────────────────────────────────────────

const VERSION = 1;

/** O que vai ao banco (`settings`): as tarefas e as tiradas, sem transcrição. Pura. */
export function serializePersisted(byKey: Record<string, ThreadTasks>): string {
  const threads: Record<string, { tasks: BgTask[]; dismissed: string[] }> = {};
  for (const [key, state] of Object.entries(byKey)) {
    const tasks = state.order.map((id) => state.tasks[id]).filter((t): t is BgTask => !!t);
    if (tasks.length === 0 && state.dismissed.length === 0) continue;
    threads[key] = { tasks, dismissed: state.dismissed.slice(-MAX_TASKS) };
  }
  return JSON.stringify({ v: VERSION, threads });
}

const STATUSES: TaskStatus[] = ["running", "completed", "failed", "stopped", "lost"];
const KINDS: TaskKind[] = ["shell", "agent", "other"];
const SOURCES: TaskSource[] = ["events", "items", "team"];

function readTask(raw: unknown, now: number): BgTask | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.startedAt !== "number") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const status = STATUSES.includes(r.status as TaskStatus) ? (r.status as TaskStatus) : "lost";
  const task: BgTask = {
    id: r.id, toolUseId: str(r.toolUseId), parentId: str(r.parentId), kind: KINDS.includes(r.kind as TaskKind) ? (r.kind as TaskKind) : "other",
    title: str(r.title) ?? "", subagent: str(r.subagent), prompt: str(r.prompt), status, startedAt: r.startedAt, endedAt: num(r.endedAt),
    durationMs: num(r.durationMs), summary: str(r.summary), lastTool: str(r.lastTool), background: r.background === true,
    stoppable: r.stoppable === true, source: SOURCES.includes(r.source as TaskSource) ? (r.source as TaskSource) : "events",
  };
  // O processo do agente não sobrevive ao app: o que rodava na abertura anterior foi interrompido.
  return task.status === "running" ? { ...task, status: "lost", endedAt: now } : task;
}

/** O que estava guardado, tolerando lixo; o que rodava volta como interrompido. Pura. */
export function parsePersisted(raw: string | null, now: number): Record<string, ThreadTasks> {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  const root = data as { v?: unknown; threads?: unknown } | null;
  if (!root || root.v !== VERSION || !root.threads || typeof root.threads !== "object") return {};
  const out: Record<string, ThreadTasks> = {};
  for (const [key, value] of Object.entries(root.threads as Record<string, unknown>)) {
    const v = (value ?? {}) as { tasks?: unknown; dismissed?: unknown };
    const tasks = (Array.isArray(v.tasks) ? v.tasks : []).map((t) => readTask(t, now)).filter((t): t is BgTask => !!t);
    const dismissed = Array.isArray(v.dismissed) ? v.dismissed.filter((d): d is string => typeof d === "string") : [];
    out[key] = { tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), order: tasks.map((t) => t.id), transcripts: {}, dismissed };
  }
  return out;
}
