import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { getRoster } from "@/features/runs/ipc";
import { STRUCTURED_AGENTS } from "@/features/chat/structured/model";
import { dateLocale } from "@/i18n/dateLocale";
import { AlertaToast } from "@/shared/ui/alerts";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { pickProjectFolder } from "@/features/chat/NewConversation";
import { useActiveBoardKey } from "./store";
import {
  baseName,
  describeTaskSchedule,
  localDateTimeInput,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
  type TaskModelOption,
  type TaskThreadTarget,
} from "./scheduledTaskModel";
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  listTaskThreadTargets,
  onScheduledTasksChanged,
  runScheduledTaskNow,
  scheduledTaskHistory,
  setScheduledTaskEnabled,
  updateScheduledTask,
} from "./scheduledTasksIpc";

const field = `w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-2 py-1
  text-[12px] text-gray-800 dark:text-gray-100 outline-none focus:border-accent-500`;
const label = "text-[11px] font-medium text-gray-600 dark:text-gray-300";
const hint = "text-[10.5px] text-gray-500 dark:text-gray-400";
const small = `cc-t h-6 px-2 rounded-md text-[11px] font-medium text-gray-600 dark:text-gray-300
  hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-40`;

function stamp(value: number | null, locale: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Date(value * 1000).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function canvasPath(key: string | null): string | null {
  if (!key) return null;
  const separator = key.indexOf("|");
  if (separator < 0) return null;
  const value = key.slice(separator + 1);
  const marker = value.search(/#(?:c|m|cmp):/);
  return marker < 0 ? value : value.slice(0, marker);
}

function freshSchedule(now: number): ScheduledTaskSchedule {
  return { kind: "once", at: Math.floor((now + 60 * 60_000) / 1000) };
}

function emptyInput(workspaceId: string | null, cwd: string, agentId: string): ScheduledTaskInput {
  return {
    name: "",
    prompt: "",
    cwd,
    workspaceId,
    agentId,
    model: null,
    effort: null,
    existingThreadId: null,
    schedule: freshSchedule(Date.now()),
  };
}

function modelOptionsFromRoster(roster: Awaited<ReturnType<typeof getRoster>>): Record<string, TaskModelOption[]> {
  return Object.fromEntries(roster.agents.map((agent) => [
    agent.agentId,
    agent.models
      .filter((model) => model.availability !== "unavailable")
      .map((model) => ({ id: model.id, label: model.label || model.id, reasoningLevels: model.reasoningLevels ?? [] })),
  ]));
}

export function ScheduledTasksPanel({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const agents = useAvailableAgents().filter((agent) => agent.id !== SHELL_AGENT_ID && STRUCTURED_AGENTS.has(agent.id));
  const workspaceId = useTabsStore((state) => state.workspaceId);
  const tabs = useTabsStore((state) => state.tabs);
  const boardKey = useActiveBoardKey();
  const currentCanvasPath = canvasPath(boardKey);

  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [threads, setThreads] = useState<TaskThreadTarget[]>([]);
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, TaskModelOption[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduledTaskInput | null>(null);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [historyByTask, setHistoryByTask] = useState<Record<string, ScheduledTaskRun[]>>({});
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const expandedHistoryRef = useRef(expandedHistory);
  expandedHistoryRef.current = expandedHistory;
  const locale = dateLocale();

  const load = useCallback(() => {
    listScheduledTasks()
      .then((list) => { setTasks(list); setLoadError(null); })
      .catch((error: unknown) => { setTasks((current) => current ?? []); setLoadError(String(error)); });
  }, []);

  useEffect(() => {
    load();
    let alive = true;
    listTaskThreadTargets()
      .then((list) => { if (alive) { setThreads(list); setThreadLoadError(null); } })
      .catch((error: unknown) => { if (alive) setThreadLoadError(String(error)); });
    getRoster(false)
      .then((roster) => { if (alive) setModelsByAgent(modelOptionsFromRoster(roster)); })
      .catch(() => { if (alive) setModelsByAgent({}); });
    return () => { alive = false; };
  }, [load]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    onScheduledTasksChanged(() => {
      void (async () => {
        const list = await listScheduledTasks();
        if (!alive) return;
        setTasks(list);
        setLoadError(null);

        const taskId = expandedHistoryRef.current;
        if (!taskId) return;
        if (!list.some((task) => task.id === taskId)) {
          setExpandedHistory((current) => current === taskId ? null : current);
          setHistoryByTask((current) => {
            const next = { ...current };
            delete next[taskId];
            return next;
          });
          return;
        }

        const history = await scheduledTaskHistory(taskId);
        if (alive && expandedHistoryRef.current === taskId) {
          setHistoryByTask((current) => ({ ...current, [taskId]: history }));
        }
      })().catch((error: unknown) => {
        if (alive) setLoadError(String(error));
      });
    }).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    }).catch((error: unknown) => {
      if (alive) setLoadError(String(error));
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const projects = useMemo(() => {
    const paths = [currentCanvasPath, ...tabs.map((tab) => tab.cwd), ...threads.map((thread) => thread.cwd), ...(tasks ?? []).map((task) => task.cwd)];
    return [...new Set(paths.filter((path): path is string => !!path))].map((cwd) => ({ cwd, name: baseName(cwd) }));
  }, [currentCanvasPath, tabs, threads, tasks]);

  const fail = (error: unknown) => AlertaToast(t("canvas.scheduledTasks.title"), String(error), "error", 6000);
  const patchDraft = (patch: Partial<ScheduledTaskInput>) => setDraft((current) => current ? { ...current, ...patch } : current);

  const startCreate = () => {
    const cwd = currentCanvasPath ?? projects[0]?.cwd ?? "";
    const agentId = agents[0]?.id ?? "";
    setEditing(null);
    setDraft(emptyInput(cwd && cwd === currentCanvasPath ? workspaceId : null, cwd, agentId));
    setFormError(null);
  };

  const startEdit = (task: ScheduledTask) => {
    setEditing(task);
    setDraft({
      name: task.name,
      prompt: task.prompt,
      cwd: task.cwd,
      workspaceId: task.workspaceId,
      agentId: task.agentId,
      model: task.model,
      effort: task.effort,
      existingThreadId: task.existingThreadId ?? null,
      schedule: task.schedule,
    });
    setFormError(null);
  };

  const selectedThread: TaskThreadTarget | null = draft?.existingThreadId
    ? threads.find((thread) => thread.id === draft.existingThreadId) ?? null
    : null;
  const savedThreadFallback: TaskThreadTarget | null = draft?.existingThreadId && editing?.existingThreadId === draft.existingThreadId && !selectedThread
    ? {
      id: editing.existingThreadId,
      title: t("canvas.scheduledTasks.threadId", { id: editing.existingThreadId.slice(0, 8) }),
      cwd: editing.cwd,
      agentId: editing.agentId,
      model: editing.model,
      effort: editing.effort,
      state: "settled",
      updatedAt: editing.updatedAt,
    }
    : null;
  const lockedThread = selectedThread ?? savedThreadFallback;

  const chooseExistingThread = (threadId: string) => {
    if (!draft) return;
    if (!threadId) {
      patchDraft({
        existingThreadId: null,
        workspaceId: draft.workspaceId ?? (draft.cwd && draft.cwd === currentCanvasPath ? workspaceId : null),
      });
      return;
    }
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    patchDraft({
      existingThreadId: thread.id,
      workspaceId: null,
      cwd: thread.cwd,
      agentId: thread.agentId,
      model: thread.model,
      effort: thread.effort,
    });
  };

  const changeAgent = (agentId: string) => patchDraft({ agentId, model: null, effort: null });
  const selectedAgent = agents.find((agent) => agent.id === draft?.agentId);
  const agentOptions = useMemo(() => {
    if (!draft || selectedAgent) return agents;
    return [{ id: draft.agentId, label: draft.agentId, command: "", available: false }, ...agents];
  }, [agents, draft, selectedAgent]);
  const modelOptions = draft ? modelsByAgent[draft.agentId] ?? [] : [];
  const selectedModel = modelOptions.find((model) => model.id === draft?.model);
  const effortOptions = selectedModel?.reasoningLevels ?? [];

  const submit = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setFormError(t("canvas.scheduledTasks.error.name")); return; }
    if (!draft.prompt.trim()) { setFormError(t("canvas.scheduledTasks.error.prompt")); return; }
    if (draft.schedule.kind === "every" && draft.schedule.secs < 300) { setFormError(t("canvas.scheduledTasks.error.interval")); return; }
    if (draft.schedule.kind === "once" && draft.schedule.at < Math.floor(Date.now() / 1000) + 60) { setFormError(t("canvas.scheduledTasks.error.once")); return; }
    if (draft.existingThreadId && !lockedThread) { setFormError(t("canvas.scheduledTasks.error.thread")); return; }
    if (!draft.existingThreadId && (!draft.cwd || !draft.agentId)) { setFormError(t("canvas.scheduledTasks.error.destination")); return; }

    const canonical = lockedThread
      ? { ...draft, workspaceId: null, cwd: lockedThread.cwd, agentId: lockedThread.agentId, model: lockedThread.model, effort: lockedThread.effort }
      : draft;
    setSaving(true);
    setFormError(null);
    try {
      if (editing) await updateScheduledTask(editing.id, canonical);
      else await createScheduledTask(canonical);
      setDraft(null);
      setEditing(null);
      load();
    } catch (error) {
      setFormError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (task: ScheduledTask) => {
    setBusyId(task.id);
    try { await setScheduledTaskEnabled(task.id, !task.enabled); load(); }
    catch (error) { fail(error); }
    finally { setBusyId(null); }
  };

  const runNow = async (task: ScheduledTask) => {
    setBusyId(task.id);
    try {
      await runScheduledTaskNow(task.id);
      load();
      if (historyByTask[task.id]) {
        const history = await scheduledTaskHistory(task.id);
        setHistoryByTask((current) => ({ ...current, [task.id]: history }));
      }
    }
    catch (error) { fail(error); }
    finally { setBusyId(null); }
  };

  const remove = async (task: ScheduledTask) => {
    setBusyId(task.id);
    try { await deleteScheduledTask(task.id); setConfirmId(null); load(); }
    catch (error) { fail(error); }
    finally { setBusyId(null); }
  };

  const toggleHistory = async (task: ScheduledTask) => {
    if (expandedHistory === task.id) { setExpandedHistory(null); return; }
    setExpandedHistory(task.id);
    if (historyByTask[task.id]) return;
    setHistoryLoading(task.id);
    try {
      const history = await scheduledTaskHistory(task.id);
      setHistoryByTask((current) => ({ ...current, [task.id]: history }));
    } catch (error) { fail(error); }
    finally { setHistoryLoading(null); }
  };

  const chooseFolder = async () => {
    try {
      const cwd = await pickProjectFolder(t("canvas.scheduledTasks.pickProject"));
      if (!cwd || !draft) return;
      patchDraft({ cwd, workspaceId: cwd === currentCanvasPath ? workspaceId : null });
    } catch (error) { setFormError(String(error)); }
  };

  return (
    <div className={embedded ? "flex min-h-0 flex-1 flex-col" : "pointer-events-auto absolute right-3 bottom-[4.75rem] w-[26rem] max-h-[70%] flex flex-col rounded-xl border border-gray-200 dark:border-white/10 bg-white/98 dark:bg-surface-raised/98 shadow-lg overflow-hidden"}>
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-gray-200 dark:border-white/10">
        <span className="text-[12.5px] font-medium text-gray-800 dark:text-gray-100">
          {draft ? editing ? t("canvas.scheduledTasks.edit") : t("canvas.scheduledTasks.new") : t("canvas.scheduledTasks.title")}
        </span>
        <span className="flex-1" />
        {!draft && <Button variant="primary" onClick={startCreate} className="h-6 px-2.5 text-[11px]">{t("canvas.scheduledTasks.new")}</Button>}
      </div>

      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <div className="flex flex-col gap-1">
            <label className={label} htmlFor="scheduled-task-name">{t("canvas.scheduledTasks.name")}</label>
            <input id="scheduled-task-name" className={field} value={draft.name} maxLength={120}
              onChange={(event) => patchDraft({ name: event.target.value })} />
          </div>

          <div className="flex flex-col gap-1">
            <label className={label} htmlFor="scheduled-task-prompt">{t("canvas.scheduledTasks.prompt")}</label>
            <textarea id="scheduled-task-prompt" className={`${field} min-h-20 resize-y`} value={draft.prompt} rows={4}
              onChange={(event) => patchDraft({ prompt: event.target.value })} />
            <span className={hint}>{t("canvas.scheduledTasks.promptHint")}</span>
          </div>

          <div className="flex flex-col gap-1">
            <span className={label}>{t("canvas.scheduledTasks.destination")}</span>
            <div role="group" aria-label={t("canvas.scheduledTasks.destination")} className="flex rounded-md bg-gray-100 dark:bg-white/6 p-0.5">
              <button type="button" aria-pressed={!draft.existingThreadId} onClick={() => chooseExistingThread("")}
                className={`flex-1 h-7 rounded text-[11px] font-medium cc-t ${!draft.existingThreadId ? "bg-white dark:bg-white/15 text-gray-800 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400"}`}>
                {t("canvas.scheduledTasks.newThread")}
              </button>
              <button type="button" aria-pressed={!!draft.existingThreadId} onClick={() => { if (threads[0]) chooseExistingThread(draft.existingThreadId ?? threads[0].id); }}
                disabled={threads.length === 0 && !draft.existingThreadId}
                className={`flex-1 h-7 rounded text-[11px] font-medium cc-t ${draft.existingThreadId ? "bg-white dark:bg-white/15 text-gray-800 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400"}`}>
                {t("canvas.scheduledTasks.existingThread")}
              </button>
            </div>
          </div>

          {draft.existingThreadId ? (
            <>
              <div className="flex flex-col gap-1">
                <label className={label} htmlFor="scheduled-task-thread">{t("canvas.scheduledTasks.thread")}</label>
                <PopupSelect id="scheduled-task-thread" className={field} value={draft.existingThreadId}
                  onChange={(event) => chooseExistingThread(event.target.value)}>
                  {lockedThread && !threads.some((thread) => thread.id === lockedThread.id) && <option value={lockedThread.id}>{lockedThread.title}</option>}
                  {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title || thread.agentId} · {baseName(thread.cwd)}</option>)}
                </PopupSelect>
                {threadLoadError && <span role="alert" className="text-[10.5px] text-red-600 dark:text-red-400">{threadLoadError}</span>}
              </div>
              {lockedThread && (
                <div className="rounded-md border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] px-2.5 py-2 text-[10.5px] text-gray-600 dark:text-gray-300">
                  <div className="truncate" title={lockedThread.cwd}>{lockedThread.cwd}</div>
                  <div className="mt-0.5">{lockedThread.agentId} · {lockedThread.model ?? t("canvas.scheduledTasks.defaultModel")}</div>
                  <div className="mt-1 text-gray-500 dark:text-gray-400">{t("canvas.scheduledTasks.inherited")}</div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <label className={label} htmlFor="scheduled-task-project">{t("canvas.scheduledTasks.project")}</label>
                <div className="flex gap-1.5">
                  <PopupSelect id="scheduled-task-project" className={`${field} min-w-0 flex-1`} value={draft.cwd}
                    onChange={(event) => {
                      const cwd = event.target.value;
                      patchDraft({ cwd, workspaceId: cwd === currentCanvasPath ? workspaceId : null });
                    }}>
                    {!projects.some((project) => project.cwd === draft.cwd) && draft.cwd && <option value={draft.cwd}>{baseName(draft.cwd)}</option>}
                    {projects.map((project) => <option key={project.cwd} value={project.cwd}>{project.name}</option>)}
                  </PopupSelect>
                  <Button variant="outline" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => void chooseFolder()}>{t("btn.browse")}</Button>
                </div>
                <span className={`${hint} truncate`} title={draft.cwd}>{draft.cwd || t("canvas.scheduledTasks.chooseProject")}</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <label className={label} htmlFor="scheduled-task-agent">{t("canvas.scheduledTasks.agent")}</label>
                  <PopupSelect id="scheduled-task-agent" className={field} value={draft.agentId} onChange={(event) => changeAgent(event.target.value)}>
                    {draft.agentId && !agents.some((agent) => agent.id === draft.agentId) && <option value={draft.agentId} disabled>{draft.agentId}</option>}
                    {agentOptions.filter((agent) => agent.available).map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
                  </PopupSelect>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <label className={label} htmlFor="scheduled-task-model">{t("canvas.scheduledTasks.model")}</label>
                  <PopupSelect id="scheduled-task-model" className={field} value={draft.model ?? ""}
                    onChange={(event) => patchDraft({ model: event.target.value || null, effort: null })}>
                    <option value="">{t("canvas.scheduledTasks.defaultModel")}</option>
                    {draft.model && !modelOptions.some((model) => model.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
                    {modelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                  </PopupSelect>
                </div>
              </div>

              {effortOptions.length > 0 && (
                <div className="flex flex-col gap-1">
                  <label className={label} htmlFor="scheduled-task-effort">{t("canvas.scheduledTasks.effort")}</label>
                  <PopupSelect id="scheduled-task-effort" className={field} value={draft.effort ?? ""}
                    onChange={(event) => patchDraft({ effort: event.target.value || null })}>
                    <option value="">{t("chat.effort.default")}</option>
                    {effortOptions.map((effort) => <option key={effort} value={effort}>{t(`chat.effort.${effort}`, { defaultValue: effort })}</option>)}
                  </PopupSelect>
                </div>
              )}
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor="scheduled-task-schedule">{t("canvas.scheduledTasks.when")}</label>
            <PopupSelect id="scheduled-task-schedule" className={field} value={draft.schedule.kind}
              onChange={(event) => {
                const kind = event.target.value as ScheduledTaskSchedule["kind"];
                const schedule: ScheduledTaskSchedule = kind === "every"
                  ? { kind, secs: 30 * 60 }
                  : kind === "daily"
                    ? { kind, hour: 9, minute: 0, days: [] }
                    : freshSchedule(Date.now());
                patchDraft({ schedule });
              }}>
              <option value="once">{t("canvas.scheduledTasks.schedule.onceOption")}</option>
              <option value="every">{t("canvas.scheduledTasks.schedule.everyOption")}</option>
              <option value="daily">{t("canvas.scheduledTasks.schedule.dailyOption")}</option>
            </PopupSelect>
            {draft.schedule.kind === "every" && (
              <div className="flex items-center gap-2">
                <input type="number" min={5} step={1} className={`${field} w-24`} aria-label={t("canvas.scheduledTasks.intervalMinutes")}
                  value={draft.schedule.secs / 60}
                  onChange={(event) => patchDraft({ schedule: { kind: "every", secs: Math.max(0, Number(event.target.value)) * 60 } })} />
                <span className={hint}>{t("canvas.scheduledTasks.intervalMinutes")}</span>
              </div>
            )}
            {draft.schedule.kind === "daily" && (
              <>
                <input type="time" aria-label={t("canvas.scheduledTasks.schedule.dailyOption")} className={`${field} w-32`}
                  value={`${String(draft.schedule.hour).padStart(2, "0")}:${String(draft.schedule.minute).padStart(2, "0")}`}
                  onChange={(event) => {
                    const [hour, minute] = event.target.value.split(":").map(Number);
                    if (draft.schedule.kind === "daily" && Number.isInteger(hour) && Number.isInteger(minute)) {
                      patchDraft({ schedule: { kind: "daily", hour, minute, days: draft.schedule.days } });
                    }
                  }} />
                <div className="flex gap-1" role="group" aria-label={t("canvas.scheduledTasks.days")}>
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                    const selected = draft.schedule.kind === "daily" && draft.schedule.days.includes(day);
                    return <button key={day} type="button" aria-pressed={selected}
                      onClick={() => {
                        if (draft.schedule.kind !== "daily") return;
                        const days = selected ? draft.schedule.days.filter((value) => value !== day) : [...draft.schedule.days, day];
                        patchDraft({ schedule: { ...draft.schedule, days: days.sort((a, b) => a - b) } });
                      }}
                      className={`flex-1 h-6 rounded-md text-[10.5px] cc-t ${selected ? "bg-accent-500/15 text-accent-600 dark:text-accent-300 font-medium" : "bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400"}`}>
                      {t(`canvas.scheduledTasks.schedule.day${day}`)}
                    </button>;
                  })}
                </div>
                <span className={hint}>{t("canvas.scheduledTasks.daysHint")}</span>
              </>
            )}
            {draft.schedule.kind === "once" && (
              <input type="datetime-local" aria-label={t("canvas.scheduledTasks.schedule.onceOption")} className={field}
                value={localDateTimeInput(new Date(draft.schedule.at * 1000))}
                onChange={(event) => {
                  const date = new Date(event.target.value);
                  if (!Number.isNaN(date.getTime())) patchDraft({ schedule: { kind: "once", at: Math.floor(date.getTime() / 1000) } });
                }} />
            )}
            <span className={hint}>{describeTaskSchedule(draft.schedule, t)}</span>
          </div>

          <div role="note" className="rounded-md border border-accent-500/20 bg-accent-500/5 px-2.5 py-2 text-[10.5px] leading-relaxed text-gray-600 dark:text-gray-300">
            {draft.existingThreadId ? t("canvas.scheduledTasks.existingSafety") : t("canvas.scheduledTasks.newSafety")}
          </div>

          {formError && <p role="alert" className="text-[10.5px] text-red-600 dark:text-red-400">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setDraft(null); setEditing(null); }} disabled={saving}>{t("canvas.scheduledTasks.cancel")}</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={saving}>{saving ? "…" : t("canvas.scheduledTasks.save")}</Button>
          </div>
        </div>
      ) : (
        <>
          <p className={`${hint} shrink-0 px-3 pt-2 pb-1`}>{t("canvas.scheduledTasks.subtitle")}</p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadError && <p role="alert" className="px-3 py-2 text-[12px] text-red-600 dark:text-red-400">{loadError}</p>}
            {tasks === null ? null : tasks.length === 0 && !loadError ? (
              <div className="flex flex-col gap-2 px-3 py-3">
                <p className="text-[12.5px] font-medium text-gray-800 dark:text-gray-100">{t("canvas.scheduledTasks.emptyTitle")}</p>
                <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-gray-400">{t("canvas.scheduledTasks.emptyText")}</p>
                <Button variant="outline" className="self-start h-7 px-2.5 text-[11px]" onClick={startCreate}>{t("canvas.scheduledTasks.new")}</Button>
              </div>
            ) : (
              (tasks ?? []).map((task) => (
                <div key={task.id} className="px-3 py-2 border-b last:border-b-0 border-gray-100 dark:border-white/6">
                  <div className="flex items-center gap-2">
                    <span title={task.name} className={`truncate text-[12.5px] font-medium ${task.enabled ? "text-gray-800 dark:text-gray-100" : "text-gray-400 dark:text-gray-500"}`}>{task.name}</span>
                    <span className="flex-1" />
                    <button type="button" role="switch" aria-checked={task.enabled} aria-label={t(task.enabled ? "canvas.scheduledTasks.pause" : "canvas.scheduledTasks.resume")}
                      disabled={busyId === task.id} onClick={() => void toggleEnabled(task)}
                      className="cc-t flex items-center gap-1.5 h-6 px-1 rounded-md text-[11px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-50">
                      <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors ${task.enabled ? "bg-accent-500" : "bg-gray-300 dark:bg-white/20"}`}>
                        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${task.enabled ? "translate-x-3" : "translate-x-0.5"}`} />
                      </span>
                      {task.enabled ? t("canvas.scheduledTasks.active") : t("canvas.scheduledTasks.paused")}
                    </button>
                  </div>

                  <div className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                    {describeTaskSchedule(task.schedule, t)} <span className="text-gray-400">·</span> {task.existingThreadId ? t("canvas.scheduledTasks.targetExisting") : t("canvas.scheduledTasks.targetNew")}
                  </div>
                  {task.enabled && task.nextRun != null && <div className="mt-0.5 text-[10.5px] text-gray-500 dark:text-gray-400">{t("canvas.scheduledTasks.nextRun", { when: stamp(task.nextRun, locale) })}</div>}
                  <div className="mt-0.5 truncate text-[10.5px] text-gray-500 dark:text-gray-400" title={task.cwd}>{baseName(task.cwd)} · {task.agentId} · {task.model ?? t("canvas.scheduledTasks.defaultModel")}</div>
                  <div className="mt-0.5 truncate text-[10.5px] text-gray-400 dark:text-gray-500" title={task.prompt}>{task.prompt}</div>
                  <div className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
                    {t("canvas.scheduledTasks.dispatchCount", { count: task.runs })}
                    {task.lastRun != null && ` · ${t("canvas.scheduledTasks.lastRun", { when: stamp(task.lastRun, locale) })}`}
                    {task.lastResult ? ` · ${task.lastResult}` : ""}
                  </div>
                  {task.schedule.kind === "once" && task.schedule.at < Math.floor(Date.now() / 1000) + 60 && !task.enabled && task.runs === 0 &&
                    <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">{t("canvas.scheduledTasks.onceExpired")}</div>}

                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Button variant="custom" className={small} disabled={busyId === task.id} onClick={() => void runNow(task)}>{t("canvas.scheduledTasks.runNow")}</Button>
                    <Button variant="custom" className={small} onClick={() => startEdit(task)}>{t("canvas.scheduledTasks.edit")}</Button>
                    <Button variant="custom" className={small} onClick={() => void toggleHistory(task)}>{expandedHistory === task.id ? t("canvas.scheduledTasks.hideHistory") : t("canvas.scheduledTasks.history")}</Button>
                    <span className="flex-1" />
                    <Button variant="custom" className="cc-t h-6 px-2 rounded-md text-[11px] font-medium text-gray-400 hover:text-red-500" onClick={() => setConfirmId(confirmId === task.id ? null : task.id)}>{t("canvas.scheduledTasks.delete")}</Button>
                  </div>

                  {confirmId === task.id && (
                    <div role="alertdialog" aria-label={t("canvas.scheduledTasks.deleteAsk", { name: task.name })}
                      className="mt-1.5 flex items-center gap-2 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-2 py-1.5">
                      <span className="flex-1 text-[11px] text-gray-700 dark:text-gray-200">{t("canvas.scheduledTasks.deleteAsk", { name: task.name })}</span>
                      <Button variant="custom" className={small} disabled={busyId === task.id} onClick={() => setConfirmId(null)}>{t("canvas.scheduledTasks.cancel")}</Button>
                      <Button variant="custom" className="cc-t h-6 px-2 rounded-md text-[11px] font-medium text-white bg-red-500 hover:bg-red-600 disabled:opacity-50"
                        disabled={busyId === task.id} onClick={() => void remove(task)}>{t("canvas.scheduledTasks.deleteYes")}</Button>
                    </div>
                  )}

                  {expandedHistory === task.id && (
                    <div className="mt-2 border-t border-gray-100 dark:border-white/6 pt-1.5">
                      <div className="mb-1 text-[10.5px] font-medium text-gray-600 dark:text-gray-300">{t("canvas.scheduledTasks.historyTitle")}</div>
                      {historyLoading === task.id ? <div className={hint}>{t("canvas.scheduledTasks.loading")}</div>
                        : (historyByTask[task.id] ?? []).length === 0
                          ? <div className={hint}>{t("canvas.scheduledTasks.historyEmpty")}</div>
                          : (historyByTask[task.id] ?? []).map((run) => (
                            <div key={run.id} className="border-t border-gray-100 dark:border-white/5 py-1.5 text-[10px] text-gray-600 dark:text-gray-300">
                              <div className="flex items-center gap-1.5">
                                <span className={run.status === "dispatched" ? "text-emerald-600 dark:text-emerald-400" : run.status === "failed" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}>{t(`canvas.scheduledTasks.history.${run.status}`)}</span>
                                <span className="text-gray-400">· {stamp(run.scheduledFor ?? run.scheduledAt, locale)}</span>
                              </div>
                              <div className="mt-0.5 truncate" title={run.cwd}>{baseName(run.cwd)} · {run.agentId} · {run.model ?? t("canvas.scheduledTasks.defaultModel")}</div>
                              <div className="mt-0.5 text-gray-400">{t("canvas.scheduledTasks.dispatchedAt", { when: stamp(run.scheduledAt, locale) })} · {t("canvas.scheduledTasks.finished", { when: stamp(run.finishedAt, locale) })}</div>
                              {run.threadId && <div className="mt-0.5 truncate text-gray-400" title={run.threadId}>{t("canvas.scheduledTasks.threadId", { id: run.threadId })}</div>}
                              {run.result && <div role="status" className={`mt-0.5 ${run.status === "failed" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>{run.result}</div>}
                            </div>
                          ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
