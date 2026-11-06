import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { StopIcon, XIcon } from "../chatIcons";
import type { ConversationCard } from "../chatModel";
import { setRightPanel, togglePanelMaximized, useChatStore } from "../store";
import { TaskDetail } from "./TaskDetail";
import { ChevronRightIcon, CollapseIcon, ExpandIcon, TrashIcon } from "./taskIcons";
import { elapsedMs, formatElapsed, taskSections, type BgTask, type TaskNode } from "./tasksModel";
import { STATUS_TONE, stopLabel } from "./taskView";
import { clearFinishedTasks, stopTask } from "./tasksStore";
import { EVENT_ENGINES, ITEM_ENGINES, useConversationTasks, useNow } from "./useConversationTasks";

const ICON_BTN = "w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white disabled:opacity-35 disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500";

/**
 * O painel "Tarefas em segundo plano" do chat, como o do Claude Code: o cabeçalho (limpar as concluídas, expandir
 * sobre a conversa, fechar), "Em execução" com o tempo correndo e o parar de cada tarefa, os filhos debaixo do pai, e
 * "Concluído" recolhido. O chevron abre o detalhe (a saída do shell ou o que o subagente fez). É uma aba do painel
 * direito (`RightPanel`): abrir tira a coluna do Resumo; fechar a traz de volta.
 */
export function TasksPanel({ conversation }: { conversation: ConversationCard | null }) {
  const { t } = useTranslation();
  const maximized = useChatStore((s) => s.panelMaximized);
  const data = useConversationTasks(conversation?.tabId ?? null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  // Os "▸ N tarefas" abertos, por tarefa: ficam abertos na volta do detalhe.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleChildren = (id: string) => setExpanded((prev) => { const next = new Set(prev); if (!next.delete(id)) next.add(id); return next; });
  const [error, setError] = useState<string | null>(null);
  const now = useNow(data.running > 0);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastOpened = useRef<string | null>(null);
  // Trocar de conversa volta à lista.
  const key = data.key;
  useEffect(() => { setOpenId(null); setError(null); setExpanded(new Set()); }, [key]);
  // Voltar do detalhe devolve o foco à linha de onde ele saiu.
  useEffect(() => {
    if (openId !== null || !lastOpened.current) return;
    rowRefs.current.get(lastOpened.current)?.focus();
    lastOpened.current = null;
  }, [openId]);

  const { running, done } = taskSections(data.tasks);
  const open = openId ? data.tasks.find((x) => x.id === openId) ?? null : null;
  const hasDone = data.tasks.some((x) => x.status !== "running");
  const stop = (task: BgTask) => { void stopTask(task, data.threadId).then(setError); };
  const openTask = (id: string) => { lastOpened.current = id; setOpenId(id); };

  return (
    <section aria-label={t("chat.tasks.title")} className="flex-1 min-h-0 flex flex-col text-chat-ui">
      {/* Maximizado, a barra flutuante do painel fica no canto de cima: o cabeçalho desce para não ficar por baixo dela. */}
      <header className={`h-11 shrink-0 flex items-center gap-1 pl-3.5 pr-2 ${maximized ? "mt-12" : ""}`}>
        <h2 className="m-0 flex-1 min-w-0 truncate text-chat-ui font-medium text-gray-900 dark:text-white">{t("chat.tasks.title")}</h2>
        <button type="button" className={ICON_BTN} disabled={!hasDone} onClick={() => clearFinishedTasks(data.key ?? "", data.derived)}
          aria-label={t("chat.tasks.clear")} title={t("chat.tasks.clear")}>
          <TrashIcon className="w-[15px] h-[15px]" />
        </button>
        <button type="button" className={ICON_BTN} onClick={togglePanelMaximized} aria-pressed={maximized}
          aria-label={maximized ? t("chat.tasks.restore") : t("chat.tasks.maximize")} title={maximized ? t("chat.tasks.restore") : t("chat.tasks.maximize")}>
          {maximized ? <CollapseIcon className="w-[15px] h-[15px]" /> : <ExpandIcon className="w-[15px] h-[15px]" />}
        </button>
        <button type="button" className={ICON_BTN} onClick={() => setRightPanel(null)} aria-label={t("chat.tasks.close")} title={t("chat.tasks.close")}>
          <XIcon className="w-[15px] h-[15px]" />
        </button>
      </header>
      {error && <p role="alert" className="mx-3.5 mb-2 mt-0 text-chat-caption text-red-700 dark:text-red-400">{error}</p>}

      {open ? (
        <TaskDetail task={open} threadId={data.threadId} transcript={open.toolUseId ? data.transcripts[open.toolUseId] ?? null : null}
          now={now} onBack={() => setOpenId(null)} onStop={() => stop(open)} />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 flex flex-col gap-4">
          {data.tasks.length === 0 && <EmptyState agentId={data.agentId} hasThread={!!data.threadId} />}
          {running.length > 0 && (
            <section aria-labelledby="cc-tasks-running">
              <h3 id="cc-tasks-running" className="m-0 mb-1.5 px-1 flex items-center gap-1.5 text-chat-caption font-medium text-gray-500 dark:text-white/50">
                {t("chat.tasks.running")}<span className="tabular-nums text-gray-400 dark:text-white/35">{running.length}</span>
              </h3>
              <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
                {running.map((node) => (
                  <TaskRow key={node.task.id} node={node} now={now} threadId={data.threadId} onOpen={openTask} onStop={stop} rowRefs={rowRefs.current} expanded={expanded} onToggle={toggleChildren} />
                ))}
              </ul>
            </section>
          )}
          {done.length > 0 && (
            <section>
              <h3 className="m-0">
                <button type="button" onClick={() => setDoneOpen(!doneOpen)} aria-expanded={doneOpen} aria-controls="cc-tasks-done"
                  className="w-full h-7 px-1 flex items-center gap-1.5 rounded-md text-chat-caption font-medium text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500">
                  <ChevronRightIcon className={`w-3.5 h-3.5 motion-safe:transition-transform ${doneOpen ? "rotate-90" : ""}`} />
                  {t("chat.tasks.done")}<span className="tabular-nums text-gray-400 dark:text-white/35">{done.length}</span>
                </button>
              </h3>
              {doneOpen && (
                <ul id="cc-tasks-done" className="list-none m-0 mt-1.5 p-0 flex flex-col gap-1.5">
                  {done.map((node) => (
                    <TaskRow key={node.task.id} node={node} now={now} threadId={data.threadId} onOpen={openTask} onStop={stop} rowRefs={rowRefs.current} expanded={expanded} onToggle={toggleChildren} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}

function EmptyState({ agentId, hasThread }: { agentId: string | null; hasThread: boolean }) {
  const { t } = useTranslation();
  const body = !hasThread ? t("chat.tasks.empty.tui") : agentId && ITEM_ENGINES.has(agentId) ? t("chat.tasks.empty.itemsOnly")
    : agentId && EVENT_ENGINES.has(agentId) ? t("chat.tasks.empty.protocol") : t("chat.tasks.empty.protocol");
  return (
    <div className="mt-1 rounded-xl border border-gray-200 dark:border-white/[0.08] px-3 py-3 flex flex-col gap-1.5 text-chat-note">
      <b className="font-semibold text-gray-900 dark:text-white">{t("chat.tasks.empty.title")}</b>
      <p className="m-0 text-gray-600 dark:text-white/60 leading-relaxed">{body}</p>
    </div>
  );
}

function TaskRow({ node, now, threadId, onOpen, onStop, rowRefs, expanded, onToggle, nested = false }: {
  node: TaskNode; now: number; threadId: string | null; onOpen: (id: string) => void; onStop: (task: BgTask) => void;
  rowRefs: Map<string, HTMLButtonElement>; expanded: ReadonlySet<string>; onToggle: (id: string) => void; nested?: boolean;
}) {
  const { t } = useTranslation();
  const { task, children } = node;
  const childrenOpen = expanded.has(task.id);
  const title = task.title || t("chat.tasks.untitled");
  const isRunning = task.status === "running";
  const stop = stopLabel(task, threadId, t);
  const time = formatElapsed(elapsedMs(task, now), t);
  return (
    <li className="flex flex-col gap-1">
      <div className={`flex items-center gap-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised ${nested ? "pl-2.5" : "pl-3"} pr-1.5 h-10`}>
        <button type="button" ref={(el) => { if (el) rowRefs.set(task.id, el); else rowRefs.delete(task.id); }}
          onClick={() => onOpen(task.id)} aria-label={t("chat.tasks.openDetail", { title })}
          className="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500">
          {isRunning && <span aria-hidden="true" className="w-1.5 h-1.5 shrink-0 rounded-full bg-accent-500 motion-safe:animate-pulse" />}
          <span className="min-w-0 truncate text-gray-900 dark:text-white" title={title}>{title}</span>
          <ChevronRightIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />
          <span className="flex-1" />
          {!isRunning && <span className={`shrink-0 text-chat-caption ${STATUS_TONE[task.status]}`}>{t(`chat.tasks.status.${task.status}`)}</span>}
          <span className="shrink-0 tabular-nums text-chat-caption text-gray-500 dark:text-white/45" aria-label={t("chat.tasks.elapsed", { time })}>{time}</span>
        </button>
        {isRunning && (
          <button type="button" disabled={!stop.enabled} aria-disabled={!stop.enabled} onClick={() => onStop(task)} aria-label={stop.label} title={stop.label}
            className={`${ICON_BTN} border border-gray-200 dark:border-white/10`}>
            <StopIcon className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
      {children.length > 0 && (
        <div className="pl-3">
          <button type="button" onClick={() => onToggle(task.id)} aria-expanded={childrenOpen}
            className="h-6 px-1 flex items-center gap-1 rounded-md text-chat-caption text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500">
            <ChevronRightIcon className={`w-3 h-3 motion-safe:transition-transform ${childrenOpen ? "rotate-90" : ""}`} />
            {t("chat.tasks.children", { count: children.length })}
          </button>
          {childrenOpen && (
            <ul className="list-none m-0 mt-1 p-0 pl-2 border-l border-gray-200 dark:border-white/[0.08] flex flex-col gap-1">
              {children.map((child) => (
                <TaskRow key={child.task.id} node={child} now={now} threadId={threadId} onOpen={onOpen} onStop={onStop} rowRefs={rowRefs} expanded={expanded} onToggle={onToggle} nested />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
