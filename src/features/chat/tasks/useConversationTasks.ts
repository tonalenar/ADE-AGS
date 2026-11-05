import { useEffect, useMemo, useState } from "react";

import { useStructured } from "../structured/store";
import { threadIdOf } from "../structured/model";
import type { TimelineItem } from "../timeline/types";
import { runningCount, tasksFromItems, visibleTasks, EMPTY_TASKS, type BgTask } from "./tasksModel";
import { useTasks } from "./tasksStore";

/** Os motores que não mandam evento de tarefa: o subagente só aparece como a ferramenta `task` da timeline. */
export const ITEM_ENGINES = new Set(["opencode", "antigravity", "cursor"]);
/** Os motores que mandam evento de tarefa (`conversa::tarefas`). */
export const EVENT_ENGINES = new Set(["claude-code", "codex"]);

const NO_ITEMS: TimelineItem[] = [];

export interface ConversationTasks {
  key: string | null;
  threadId: string | null;
  agentId: string | null;
  tasks: BgTask[];
  /** As que saem da timeline (para a lixeira lembrar das tiradas). */
  derived: BgTask[];
  transcripts: Record<string, TimelineItem[]>;
  running: number;
}

/** As tarefas da conversa (`thread:<id>`): as do backend e, nos motores sem evento, as da timeline. */
export function useConversationTasks(key: string | null): ConversationTasks {
  const threadId = key ? threadIdOf(key) : null;
  const agentId = useStructured((s) => (threadId ? s.threads.find((t) => t.id === threadId)?.agentId ?? null : null));
  const items = useStructured((s) => (threadId && agentId && ITEM_ENGINES.has(agentId) ? s.live[threadId]?.items ?? NO_ITEMS : NO_ITEMS));
  const state = useTasks((s) => (key ? s.byKey[key] : undefined) ?? EMPTY_TASKS);
  const derived = useMemo(() => tasksFromItems(items), [items]);
  const tasks = useMemo(() => (threadId ? visibleTasks(state, derived) : []), [state, derived, threadId]);
  return { key: threadId ? key : null, threadId, agentId, tasks, derived, transcripts: state.transcripts, running: runningCount(tasks) };
}

/** O relógio da tela: muda a cada `ms` enquanto `on` (para o tempo decorrido das que rodam). */
export function useNow(on: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [on, ms]);
  return now;
}
