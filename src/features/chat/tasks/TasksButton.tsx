import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStructured } from "../structured/store";
import { threadKey } from "../structured/model";
import { setRightPanel, useChatStore } from "../store";
import { TasksIcon } from "./taskIcons";
import { startTasks, useTasks } from "./tasksStore";
import { useConversationTasks } from "./useConversationTasks";

/** Quanto o botão fica marcado depois de uma tarefa começar (sem abrir o painel). */
export const PULSE_MS = 4_000;

/** A conversa por protocolo à vista (`thread:<id>`), ou `null` (aba de TUI, conversa nova). */
export function useActiveThreadKey(): string | null {
  const thread = useChatStore((s) => (s.composing ? null : s.thread));
  const active = useStructured((s) => (thread ? s.threads.some((t) => t.id === thread && t.state === "active") : false));
  return thread && active ? threadKey(thread) : null;
}

/**
 * O botão "Tarefas em segundo plano" da fileira do cabeçalho: o número das que rodam num selo, e um destaque curto
 * quando uma começa (o painel nunca abre sozinho). Abre e fecha a aba do painel direito; fica sempre na fileira.
 */
export function TasksButton() {
  const { t } = useTranslation();
  useEffect(() => startTasks(), []);
  const key = useActiveThreadKey();
  const { running } = useConversationTasks(key);
  const open = useChatStore((s) => s.panel === "tasks");
  const pulseAt = useTasks((s) => (key ? s.pulse[key] ?? 0 : 0));
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!pulseAt || Date.now() - pulseAt > PULSE_MS) return;
    setPulsing(true);
    const id = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(id);
  }, [pulseAt]);
  const label = running > 0 ? t("chat.tasks.openCount", { count: running }) : t("chat.tasks.title");
  return (
    <button type="button" onClick={() => setRightPanel(open ? null : "tasks")} aria-pressed={open} aria-label={label} title={label}
      data-tasks-button=""
      className={`relative w-8 h-8 shrink-0 flex items-center justify-center rounded-lg transition-colors
        ${open ? "bg-gray-200/80 dark:bg-white/[0.12] text-gray-900 dark:text-white"
          : pulsing ? "bg-accent-500/15 text-accent-600 dark:text-accent-400"
            : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"}`}>
      <TasksIcon className={`w-[18px] h-[18px] ${pulsing && !open ? "motion-safe:animate-pulse" : ""}`} />
      {running > 0 && (
        <span aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-accent-500 text-white text-[10px] leading-4 font-semibold tabular-nums text-center">
          {running > 9 ? "9+" : running}
        </span>
      )}
    </button>
  );
}
