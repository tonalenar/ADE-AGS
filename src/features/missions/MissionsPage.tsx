import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Alert, AnimateSpin, Button, EmptyState, LocationIcon } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import type { Task } from "@/features/runs/types";

import { MissionDialog } from "./MissionDialog";
import {
  AGENT_STATES, agentStateOf, canEdit, countAgentStates, dependencyLabels, emptyForm, formFromMission, missionAction, progressOf,
} from "./missionView";
import { useMissionsStore } from "./store";
import type { MissionDetail, MissionStatus, MissionSummary } from "./types";

/** El evento del supervisor cuando cambia una tarea. Debe coincidir con `runs/supervisor.rs`. */
const TASK_CHANGED = "cc-task-changed";

const STATUS_TONE: Record<MissionStatus, string> = {
  draft: "bg-gray-200 text-gray-700 dark:bg-white/10 dark:text-white/60",
  running: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  done: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  cancelled: "bg-gray-200 text-gray-500 dark:bg-white/8 dark:text-white/40",
};

/**
 * Las misiones del workspace: lo que se quiere lograr, con su estado y su run activo.
 *
 * Crear una misión es solo guardarla como borrador; nada se lanza hasta "Iniciar". La
 * ejecución se sigue viendo también en la flota, porque son las mismas tareas.
 */
export function MissionsPage() {
  const { t } = useTranslation();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const missions = useMissionsStore((s) => s.missions);
  const details = useMissionsStore((s) => s.details);
  const loaded = useMissionsStore((s) => s.loaded);
  const load = useMissionsStore((s) => s.load);
  const loadDetail = useMissionsStore((s) => s.loadDetail);
  const onTaskChanged = useMissionsStore((s) => s.onTaskChanged);

  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);
  const [error, setError] = useState("");

  const cwd = tabs.find((tb) => tb.id === activeTabId)?.cwd ?? tabs[0]?.cwd ?? "";

  useEffect(() => {
    if (workspaceId) load(workspaceId).catch((e) => setError(String(e)));
  }, [workspaceId, load]);

  useEffect(() => {
    if (selected) loadDetail(selected).catch((e) => setError(String(e)));
  }, [selected, loadDetail]);

  // Una tarea que cambia es lo único que mueve a una misión en curso.
  useEffect(() => {
    if (!workspaceId) return;
    const off = listen<string>(TASK_CHANGED, () => {
      onTaskChanged(workspaceId, selected).catch(console.error);
    });
    return () => { off.then((f) => f()).catch(() => {}); };
  }, [workspaceId, selected, onTaskChanged]);

  const summary = missions.find((m) => m.id === selected) ?? null;
  const detail = selected ? details[selected] ?? null : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 h-[54px] shrink-0 pl-4 pr-14 border-b border-gray-200 dark:border-white/8">
        <LocationIcon className="w-[15px] h-[15px] shrink-0 text-violet-500 dark:text-violet-400" />
        <span className="text-[13.5px] font-bold text-gray-900 dark:text-white">{t("missions.title")}</span>
        <div className="flex-1" />
        <Button variant="primary" size="sm" disabled={!workspaceId} onClick={() => setDialog("new")}>
          {t("missions.new")}
        </Button>
      </div>

      {error && (
        <div className="shrink-0 px-4 py-2 text-[11px] border-b text-red-600 dark:text-red-400
          border-red-200/60 dark:border-red-500/20 bg-red-50 dark:bg-red-500/8">
          {error}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="w-80 shrink-0 cc-scroll border-r border-gray-200 dark:border-white/8">
          {loaded && missions.length === 0 ? (
            <EmptyState
              className="py-16 px-4"
              icon={<LocationIcon className="w-8 h-8" />}
              title={t("missions.empty.title")}
              description={t("missions.empty.desc")}
            />
          ) : (
            missions.map((m) => (
              <MissionRow key={m.id} mission={m} active={m.id === selected} onSelect={() => setSelected(m.id)} />
            ))
          )}
        </div>

        <div className="flex-1 min-w-0 cc-scroll">
          {summary && detail ? (
            <MissionDetailView
              summary={summary}
              detail={detail}
              onEdit={() => setDialog("edit")}
              onError={setError}
            />
          ) : (
            <p className="p-6 text-[12px] text-gray-400 dark:text-white/35">{t("missions.pick")}</p>
          )}
        </div>
      </div>

      {dialog && workspaceId && (
        <MissionDialog
          editing={dialog === "edit"}
          initial={dialog === "edit" && detail ? formFromMission(detail.mission) : emptyForm(cwd)}
          onClose={() => setDialog(null)}
          onSave={async (input) => {
            setError("");
            if (dialog === "edit" && selected) {
              await useMissionsStore.getState().update(workspaceId, selected, input);
            } else {
              const created = await useMissionsStore.getState().create(workspaceId, input);
              setSelected(created.id);
            }
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: MissionStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`shrink-0 px-1.5 h-[18px] inline-flex items-center rounded text-[10px] font-medium ${STATUS_TONE[status]}`}>
      {t(`missions.status.${status}`)}
    </span>
  );
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function MissionRow({ mission, active, onSelect }: { mission: MissionSummary; active: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const progress = progressOf(mission);
  const lead = mission.leadAgent ?? mission.leadAgentId;
  return (
    <Button variant="custom"
      onClick={onSelect}
      aria-pressed={active}
      className={`cc-t w-full flex flex-col items-stretch gap-1 px-3 py-2.5 text-left rounded-none
        border-b border-gray-100 dark:border-white/5
        ${active ? "bg-blue-500/10" : "hover:bg-gray-100 dark:hover:bg-white/4"}`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="flex-1 truncate text-[12px] font-medium text-gray-900 dark:text-gray-100">{mission.title}</span>
        <StatusBadge status={mission.status} />
      </span>
      <span className="flex items-center gap-2 min-w-0 text-[10.5px] text-gray-400 dark:text-white/35">
        <span className="truncate font-mono" title={mission.cwd}>{folderName(mission.cwd)}</span>
        <span>·</span>
        <span className="shrink-0">{lead ?? t("missions.autoLead")}</span>
        <span className="flex-1" />
        <span className="shrink-0 tabular-nums">{new Date(mission.createdAt * 1000).toLocaleDateString()}</span>
      </span>
      {(progress || mission.spentUsd > 0) && (
        <span className="flex items-center gap-2 text-[10.5px] tabular-nums text-gray-500 dark:text-white/45">
          {progress && <span>{t("missions.progress", { done: progress.done, total: progress.total })}</span>}
          {mission.spentUsd > 0 && <span>${mission.spentUsd.toFixed(3)}</span>}
        </span>
      )}
    </Button>
  );
}

function MissionDetailView({ summary, detail, onEdit, onError }: {
  summary: MissionSummary;
  detail: MissionDetail;
  onEdit: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const [busy, setBusy] = useState(false);
  const { mission, tasks, facts, runs } = detail;
  const run = runs.find((r) => r.id === mission.activeRunId) ?? null;
  const lead = tasks.find((tk) => tk.role === "lead") ?? null;
  const action = missionAction(mission.status);
  const counts = countAgentStates(tasks);

  const act = async (kind: "start" | "cancel") => {
    if (!workspaceId) return;
    setBusy(true);
    onError("");
    try {
      const store = useMissionsStore.getState();
      await (kind === "start" ? store.start(workspaceId, mission.id) : store.cancel(workspaceId, mission.id));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const provider = lead
    ? `${lead.agentId}${lead.model ? ` · ${lead.model}` : ""}`
    : mission.leadAgentId
      ? `${mission.leadAgentId}${mission.leadModel ? ` · ${mission.leadModel}` : ""}`
      : t("missions.autoProvider", { complexity: t(`fleet.complexity.${mission.complexity ?? "hard"}`) });
  const account = lead
    ? (lead.accountId ?? t("accounts.system"))
    : mission.autoAccount ? t("missions.autoAccount") : (mission.leadAccountId ?? t("accounts.system"));

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-gray-900 dark:text-white">{mission.title}</h2>
            <StatusBadge status={mission.status} />
          </span>
          <span className="truncate font-mono text-[10.5px] text-gray-400 dark:text-white/35">{mission.cwd}</span>
        </div>
        {canEdit(mission.status) && (
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>{t("missions.edit")}</Button>
        )}
        {action && (
          <Button
            variant={action === "start" ? "primary" : "danger"}
            size="sm"
            disabled={busy}
            onClick={() => act(action)}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {t(`missions.action.${action}`)}
          </Button>
        )}
      </div>

      {mission.status === "draft" && <Alert variant="info">{t("missions.draftNotice")}</Alert>}

      <Section title={t("missions.detail.objective")}>
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700 dark:text-gray-300">{mission.objective}</p>
      </Section>

      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label={t("missions.detail.provider")} value={provider} />
        <Stat label={t("missions.detail.account")} value={account} />
        <Stat
          label={t("missions.detail.budget")}
          value={mission.budgetUsd !== null ? `$${mission.budgetUsd.toFixed(2)}` : t("missions.detail.noBudget")}
        />
        <Stat label={t("missions.detail.spent")} value={`$${summary.spentUsd.toFixed(3)}`} />
      </dl>

      {run && (
        <Section title={t("missions.detail.run")}>
          <p className="text-[11.5px] text-gray-600 dark:text-white/55">
            <span className="font-mono">{run.id.slice(0, 8)}</span>
            {" · "}{t(`missions.runStatus.${run.status}`)}
            {" · "}{t("fleet.runs.parallel", { n: run.maxParallel })}
            {runs.length > 1 && ` · ${t("missions.detail.attempts", { n: runs.length })}`}
          </p>
          <p className="flex flex-wrap gap-3 text-[11px] tabular-nums text-gray-500 dark:text-white/45">
            {AGENT_STATES.filter((s) => counts[s] > 0).map((s) => (
              <span key={s}>{t(`missions.agents.${s}`, { n: counts[s] })}</span>
            ))}
          </p>
        </Section>
      )}

      {tasks.length > 0 && (
        <Section title={t("missions.detail.tasks")}>
          <ul className="flex flex-col divide-y divide-gray-100 dark:divide-white/5 rounded-lg border border-gray-200 dark:border-white/8">
            {tasks.map((task) => <TaskRow key={task.id} task={task} tasks={tasks} />)}
          </ul>
        </Section>
      )}

      {facts.length > 0 && (
        <Section title={t("fleet.runs.factsTitle")}>
          <ul className="flex flex-col gap-1">
            {facts.map((f) => (
              <li key={f.id} className="text-[11.5px] text-gray-600 dark:text-white/55">
                <span className="font-medium">[{t(`fleet.runs.kind.${f.kind}`)}]</span> {f.body}
                <span className="text-gray-400 dark:text-white/30"> — {f.author ?? t("fleet.runs.authorUser")}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function TaskRow({ task, tasks }: { task: Task; tasks: Task[] }) {
  const { t } = useTranslation();
  const deps = dependencyLabels(task, tasks);
  const state = agentStateOf(task);
  const outcome = task.error ?? task.result;
  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <span className="flex items-center gap-2 min-w-0 text-[11.5px]">
        <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} />
        {task.role === "lead" && (
          <span className="shrink-0 text-[9.5px] font-bold uppercase text-violet-600 dark:text-violet-400">{t("fleet.card.lead")}</span>
        )}
        <span className="flex-1 truncate font-medium text-gray-800 dark:text-gray-200">{task.planKey ?? task.title}</span>
        <span className="shrink-0 text-[10.5px] text-gray-400 dark:text-white/35">
          {task.agentId}{task.model ? ` · ${task.model}` : ""}
        </span>
        <span className="shrink-0 text-[10.5px] text-gray-500 dark:text-white/45">{t(`fleet.status.${task.status}`)}</span>
        {task.costUsd !== null && <span className="shrink-0 tabular-nums text-[10.5px] text-gray-400">${task.costUsd.toFixed(3)}</span>}
      </span>
      {deps.length > 0 && (
        <span className="pl-3.5 text-[10.5px] text-gray-400 dark:text-white/35">{t("missions.detail.dependsOn", { deps: deps.join(", ") })}</span>
      )}
      {task.handoff && (
        <span className="pl-3.5 text-[10.5px] text-amber-700 dark:text-amber-400">{t("missions.detail.handedOver")}</span>
      )}
      {outcome && (
        <p className={`pl-3.5 whitespace-pre-wrap line-clamp-3 font-mono text-[10.5px] leading-relaxed
          ${task.error ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-white/45"}`}>
          {outcome}
        </p>
      )}
    </li>
  );
}

const STATE_DOT = {
  working: "bg-emerald-500 animate-pulse",
  queued: "bg-amber-400",
  done: "bg-blue-500",
  failed: "bg-red-500",
  stopped: "bg-gray-300 dark:bg-white/20",
} as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-white/30">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0 px-3 py-2 rounded-lg bg-gray-100/70 dark:bg-white/4">
      <dt className="text-[10px] text-gray-400 dark:text-white/35">{label}</dt>
      <dd className="truncate text-[12px] font-medium text-gray-800 dark:text-gray-200" title={value}>{value}</dd>
    </div>
  );
}
