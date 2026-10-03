import { HandoffView } from "@/features/runs/HandoffView";
import { SharedMemoryPanel, type MemoryTab } from "@/features/memory/SharedMemoryPanel";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Alert, AnimateSpin, Button, EmptyState, LocationIcon } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { accountProblemText } from "@/features/accounts/problem";
import { PermissionCard } from "@/features/runs/PermissionCard";
import { useRunsStore } from "@/features/runs/store";
import { getRoster } from "@/features/runs/ipc";
import { leadUnsupported } from "@/features/runs/leadProviders";
import type { Roster } from "@/features/runs/types";
import type { PendingApproval, Task } from "@/features/runs/types";
import { useSquadsStore } from "@/features/squads/store";
import { useSquadAccountLabel } from "@/features/squads/accountLabel";
import type { Squad } from "@/features/squads/types";

import { AutonomyPicker } from "./AutonomyPicker";
import { MissionDialog } from "./MissionDialog";
import { MissionMap } from "./MissionMap";
import { MissionTimingsPanel } from "./MissionTimingsPanel";
import { startMissionInTerminals } from "./terminals";
import { MissionReviewPanel } from "./MissionReviewPanel";
import {
  AGENT_STATES, agentStateOf, approvalsFor, blockedRuns, canEdit, countAgentStates, dependencyLabels, emptyForm,
  formFromMission, missionAction, missionPhase, progressOf, workersOf, type MissionPhase, type Progress,
} from "./missionView";
import { useMissionsStore } from "./store";
import type { MissionDetail, MissionSummary } from "./types";

/** El evento del supervisor cuando cambia una tarea. Debe coincidir con `runs/supervisor.rs`. */
const TASK_CHANGED = "cc-task-changed";
/** El de una misión creada, editada, arrancada, cerrada o cancelada. Ver `missions/mod.rs`. */
const MISSION_CHANGED = "cc-mission-changed";
const SQUAD_CHANGED = "cc-squad-changed";

const STATUS_TONE: Record<MissionPhase, string> = {
  draft: "bg-gray-200 text-gray-700 dark:bg-white/10 dark:text-white/60",
  running: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  waiting_approval: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  done: "bg-accent-500/15 text-accent-700 dark:text-accent-300",
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
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const missions = useMissionsStore((s) => s.missions);
  const details = useMissionsStore((s) => s.details);
  const loaded = useMissionsStore((s) => s.loaded);
  const load = useMissionsStore((s) => s.load);
  const loadDetail = useMissionsStore((s) => s.loadDetail);
  const onTaskChanged = useMissionsStore((s) => s.onTaskChanged);
  const onMissionChanged = useMissionsStore((s) => s.onMissionChanged);
  const squads = useSquadsStore((s) => s.squads);
  const loadSquads = useSquadsStore((s) => s.load);

  const [selected, setSelected] = useState<string | null>(null);
  const [focusTab, setFocusTab] = useState<MemoryTab>("workspace");
  const [focusNonce, setFocusNonce] = useState(0);
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const state = location.state as { focusMission?: string | null; memoryTab?: MemoryTab } | null;
    if (!state) return;
    setSelected(state.focusMission ?? null);
    setFocusTab(state.memoryTab ?? "workspace");
    setFocusNonce((n) => n + 1);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const cwd = tabs.find((tb) => tb.id === activeTabId)?.cwd ?? tabs[0]?.cwd ?? "";

  useEffect(() => {
    if (workspaceId) load(workspaceId).catch((e) => setError(String(e)));
  }, [workspaceId, load]);

  useEffect(() => { loadSquads().catch((e) => setError(String(e))); }, [loadSquads]);

  useEffect(() => {
    const off = listen<{ squad_id: string }>(SQUAD_CHANGED, () => { loadSquads().catch(console.error); });
    return () => { off.then((unlisten) => unlisten()).catch(() => {}); };
  }, [loadSquads]);

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

  useEffect(() => {
    if (!workspaceId) return;
    const off = listen<string>(MISSION_CHANGED, (e) => {
      onMissionChanged(workspaceId, e.payload, selected).catch(console.error);
    });
    return () => { off.then((f) => f()).catch(() => {}); };
  }, [workspaceId, selected, onMissionChanged]);

  const summary = missions.find((m) => m.id === selected) ?? null;
  const detail = selected ? details[selected] ?? null : null;
  const selectedSquad = (detail?.mission.squadId ?? summary?.squadId)
    ? squads.find((squad) => squad.id === (detail?.mission.squadId ?? summary?.squadId)) ?? null
    : null;

  // La cola de permisos es la de la flota (la mantiene `useFleetEvents` desde el shell):
  // decidir acá o allá es lo mismo, y los dos lados se enteran por el mismo evento.
  const approvals = useRunsStore((s) => s.approvals);
  const fleetTasks = useRunsStore((s) => s.tasks);
  const blocked = useMemo(
    () => blockedRuns(approvals, detail ? [...fleetTasks, ...detail.tasks] : fleetTasks),
    [approvals, fleetTasks, detail]
  );
  const waiting = (m: { activeRunId: string | null }) => m.activeRunId !== null && blocked.has(m.activeRunId);

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
              <MissionRow
                key={m.id}
                mission={m}
                phase={missionPhase(m.status, waiting(m))}
                active={m.id === selected}
                onSelect={() => setSelected(m.id)}
              />
            ))
          )}
        </div>

        <div className="flex-1 min-w-0 cc-scroll">
          {summary && detail ? (
            <MissionDetailView
              summary={summary}
              detail={detail}
              squad={selectedSquad}
              approvals={approvalsFor(approvals, detail.tasks)}
              onEdit={() => setDialog("edit")}
              onError={setError}
              focusTab={focusTab}
              focusNonce={focusNonce}
            />
          ) : (
            workspaceId ? (
              <div className="flex flex-col gap-4 p-5">
                <p className="text-[12px] text-gray-400 dark:text-white/35">{t("missions.pick")}</p>
                <SharedMemoryPanel
                  key={`${workspaceId}-${focusNonce}`}
                  workspaceId={workspaceId}
                  initialTab={focusTab === "mission" ? "workspace" : focusTab}
                />
              </div>
            ) : <p className="p-6 text-[12px] text-gray-400 dark:text-white/35">{t("missions.pick")}</p>
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

function StatusBadge({ phase }: { phase: MissionPhase }) {
  const { t } = useTranslation();
  return (
    <span className={`shrink-0 px-1.5 h-[18px] inline-flex items-center rounded text-[10px] font-medium ${STATUS_TONE[phase]}`}>
      {t(`missions.status.${phase}`)}
    </span>
  );
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function MissionRow({ mission, phase, active, onSelect }: {
  mission: MissionSummary;
  phase: MissionPhase;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const progress = progressOf(mission);
  const lead = mission.leadAgent ?? mission.leadAgentId;
  return (
    <Button variant="custom"
      onClick={onSelect}
      aria-pressed={active}
      className={`cc-t w-full flex flex-col items-stretch gap-1 px-3 py-2.5 text-left rounded-none
        border-b border-gray-100 dark:border-white/5
        ${active ? "bg-accent-500/10" : "hover:bg-gray-100 dark:hover:bg-white/4"}`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="flex-1 truncate text-[12px] font-medium text-gray-900 dark:text-gray-100">{mission.title}</span>
        <StatusBadge phase={phase} />
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
          {progress && <ProgressLabel progress={progress} />}
          {mission.spentUsd > 0 && <span>${mission.spentUsd.toFixed(3)}</span>}
        </span>
      )}
    </Button>
  );
}

function ProgressLabel({ progress }: { progress: Progress }) {
  const { t } = useTranslation();
  return (
    <span>
      {progress.kind === "planning"
        ? t("missions.leadPlanning")
        : t("missions.progress", { done: progress.done, total: progress.total })}
    </span>
  );
}

function MissionDetailView({ summary, detail, squad, approvals, onEdit, onError, focusTab, focusNonce }: {
  summary: MissionSummary;
  detail: MissionDetail;
  squad: Squad | null;
  /** Los permisos que esperan en las tareas de su run activo. */
  approvals: PendingApproval[];
  onEdit: () => void;
  onError: (e: string) => void;
  focusTab: MemoryTab;
  focusNonce: number;
}) {
  const { t } = useTranslation();
  const accountLabel = useSquadAccountLabel();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const decideApproval = useRunsStore((s) => s.decideApproval);
  const navigate = useNavigate();
  const roles = useSquadsStore((s) => s.roles);
  const loadRoles = useSquadsStore((s) => s.loadRoles);
  useEffect(() => { loadRoles().catch(() => undefined); }, [loadRoles]);
  const [busy, setBusy] = useState(false);
  const { mission, tasks, runs } = detail;
  const [roster, setRoster] = useState<Roster | null>(null);
  useEffect(() => { getRoster().then(setRoster).catch(() => setRoster(null)); }, []);
  const unsupportedLead = leadUnsupported(roster?.agents.find((agent) => agent.agentId === mission.leadAgentId));
  const run = runs.find((r) => r.id === mission.activeRunId) ?? null;
  const lead = tasks.find((tk) => tk.role === "lead") ?? null;
  const action = missionAction(mission.status);
  const blockedTasks = useMemo(() => new Set(approvals.map((a) => a.taskId)), [approvals]);
  const phase = missionPhase(mission.status, approvals.length > 0);
  const workers = workersOf(tasks);
  const counts = countAgentStates(workers, blockedTasks);
  const progress = progressOf(summary);
  const firstApproval = approvals[0]?.id ?? null;

  const act = async (kind: "start" | "retry" | "cancel") => {
    if (!workspaceId) return;
    setBusy(true);
    onError("");
    try {
      const store = useMissionsStore.getState();
      if (kind === "cancel") {
        await store.cancel(workspaceId, mission.id);
      } else {
        // Iniciar abre el equipo en terminales reales en el canvas de la misión.
        await startMissionInTerminals(mission, squad ?? null, roles);
        await store.load(workspaceId).catch(() => undefined);
        navigate("/workspace");
      }
    } catch (e) {
      const problem = String(e);
      onError(t(problem, { defaultValue: problem }));
    } finally {
      setBusy(false);
    }
  };

  const provider = lead
    ? `${lead.agentId}${lead.model ? ` · ${lead.model}` : ""}`
    : squad
      ? `${squad.lead.agentId}${squad.lead.model ? ` · ${squad.lead.model}` : ""}`
    : mission.leadAgentId
      ? `${mission.leadAgentId}${mission.leadModel ? ` · ${mission.leadModel}` : ""}`
      : t("missions.autoProvider", { complexity: t(`fleet.complexity.${mission.complexity ?? "hard"}`) });
  const account = lead
    ? accountLabel(lead.accountId, false)
    : squad
      ? accountLabel(squad.lead.accountId, squad.lead.autoAccount)
    : mission.autoAccount ? t("missions.autoAccount") : (mission.leadAccountId ?? t("accounts.system"));
  const unavailableSquad = Boolean(mission.squadId && (!squad || !squad.available));

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-gray-900 dark:text-white">{mission.title}</h2>
            <StatusBadge phase={phase} />
          </span>
          <span className="truncate font-mono text-[10.5px] text-gray-400 dark:text-white/35">{mission.cwd}</span>
        </div>
        {canEdit(mission.status) && (
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>{t("missions.edit")}</Button>
        )}
        {action && (
          <Button
            variant={action === "cancel" ? "danger" : "primary"}
            size="sm"
            disabled={busy || (action !== "cancel" && (unavailableSquad || unsupportedLead))}
            onClick={() => act(action)}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {t(`missions.action.${action}`)}
          </Button>
        )}
      </div>

      {mission.status === "draft" && <Alert variant="info">{t("missions.draftNotice")}</Alert>}
      {mission.status === "failed" && <Alert variant="info">{t("missions.retryNotice")}</Alert>}
      {action && action !== "cancel" && unsupportedLead && <Alert variant="warning">{t("squads.leadUnsupported")}</Alert>}
      {action && action !== "cancel" && mission.squadId && unavailableSquad && (
        <Alert variant="warning">
          {squad ? squad.unavailableReasons.join("; ") : t("missions.squadUnavailable")}
        </Alert>
      )}
      {phase === "waiting_approval" && (
        <Alert variant="warning">{t("missions.waitingNotice", { count: approvals.length })}</Alert>
      )}

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

      {run?.squadName ? (
        <Section title={t("missions.squadUsed", { name: run.squadName })}>
          <div className="flex flex-col gap-1.5 text-[10.5px] text-gray-500 dark:text-white/45">
            {lead && (
              <div className="flex justify-between gap-3">
                <span className="font-medium text-violet-700 dark:text-violet-300">{t("squads.lead")}</span>
                <span className="truncate text-right">
                  {lead.agentId}{lead.model ? ` · ${lead.model}` : ""} · {accountLabel(lead.accountId, false)}
                </span>
              </div>
            )}
            {run.squadMembers?.map((member) => (
              <div key={member.roleId} className="flex justify-between gap-3">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {t(`squads.roleNames.${member.roleId}`, { defaultValue: member.roleId })}
                </span>
                <span className="truncate text-right">
                  {member.agentId}{member.model ? ` · ${member.model}` : ""} · {accountLabel(member.accountId, member.autoAccount)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : squad ? (
        <Section title={t("squads.title")}>
          <SquadSummary squad={squad} accountLabel={accountLabel} />
        </Section>
      ) : null}

      {run && (
        <Section title={t("missions.detail.run")}>
          <p className="text-[11.5px] text-gray-600 dark:text-white/55">
            <span className="font-mono">{run.id.slice(0, 8)}</span>
            {" · "}{t(`missions.runStatus.${run.status}`)}
            {" · "}{t("fleet.runs.parallel", { n: run.maxParallel })}
            {runs.length > 1 && ` · ${t("missions.detail.attempts", { n: runs.length })}`}
          </p>
          <p className="flex flex-wrap gap-3 text-[11px] tabular-nums text-gray-500 dark:text-white/45">
            {lead && (
              <span className="font-medium text-violet-600 dark:text-violet-400">
                {t("missions.leadState", { state: t(`missions.state.${agentStateOf(lead, tasks, blockedTasks)}`) })}
              </span>
            )}
            {progress && <ProgressLabel progress={progress} />}
            {AGENT_STATES.filter((s) => counts[s] > 0).map((s) => (
              <span key={s}>{t(`missions.agents.${s}`, { n: counts[s] })}</span>
            ))}
          </p>
        </Section>
      )}

      <MissionMap tasks={tasks} accountLabel={accountLabel} />

      {mission.status === "draft" && (
        <Section title={t("missions.autonomy.title")}>
          <AutonomyPicker />
        </Section>
      )}

      {mission.status !== "draft" && (
        <Section title={t("missions.timings.title")}>
          <MissionTimingsPanel missionId={mission.id} />
        </Section>
      )}

      {tasks.length > 0 && (
        <Section title={t("missions.detail.tasks")}>
          <ul className="flex flex-col divide-y divide-gray-100 dark:divide-white/5 rounded-lg border border-gray-200 dark:border-white/8">
            {tasks.map((task) => {
              const approval = approvals.find((a) => a.taskId === task.id);
              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  tasks={tasks}
                  accountLabel={accountLabel}
                  blocked={blockedTasks}
                  approval={approval}
                  focused={approval?.id === firstApproval}
                  onDecide={(allow, remember) => {
                    if (approval) decideApproval(approval.id, allow, remember).catch((e) => onError(String(e)));
                  }}
                />
              );
            })}
          </ul>
        </Section>
      )}

      <MissionReviewPanel missionId={mission.id} refreshKey={tasks.map((task) => `${task.id}:${task.status}`).join("|")} />

      {workspaceId && <SharedMemoryPanel key={`${workspaceId}-${mission.id}-${focusNonce}`} workspaceId={workspaceId} missionId={mission.id} runs={runs} activeRunId={mission.activeRunId} initialTab={focusTab} />}
    </div>
  );
}

function TaskRow({ task, tasks, accountLabel, blocked, approval, focused, onDecide }: {
  task: Task;
  tasks: Task[];
  accountLabel: (accountId: string | null, autoAccount: boolean) => string;
  blocked: ReadonlySet<string>;
  approval?: PendingApproval;
  focused: boolean;
  onDecide: (allow: boolean, remember: boolean) => void;
}) {
  const { t } = useTranslation();
  const deps = dependencyLabels(task, tasks);
  const state = agentStateOf(task, tasks, blocked);
  const outcome = task.error ? accountProblemText(task.error, t) : task.result;
  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <span className="flex items-center gap-2 min-w-0 text-[11.5px]">
        <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} />
        {task.role === "lead" && (
          <span className="shrink-0 text-[9.5px] font-bold uppercase text-violet-600 dark:text-violet-400">{t("fleet.card.lead")}</span>
        )}
        {task.functionalRole && (
          <span className="shrink-0 rounded px-1 py-px text-[9px] font-semibold text-sky-700 dark:text-sky-300 bg-sky-500/10">
            {t(`squads.roleNames.${task.functionalRole}`, { defaultValue: task.functionalRole })}
          </span>
        )}
        <span className="flex-1 truncate font-medium text-gray-800 dark:text-gray-200">{task.planKey ?? task.title}</span>
        <span className="shrink-0 text-[10.5px] text-gray-400 dark:text-white/35">
          {task.agentId}{task.model ? ` · ${task.model}` : ""}{task.accountId ? ` · ${accountLabel(task.accountId, false)}` : ""}
        </span>
        <span className="shrink-0 text-[10.5px] text-gray-500 dark:text-white/45">{t(`missions.state.${state}`)}</span>
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
      <HandoffView task={task} />
      {approval && (
        <div className="-mx-3 -mb-2 pt-1">
          <PermissionCard approval={approval} focused={focused} onDecide={onDecide} />
        </div>
      )}
    </li>
  );
}

function SquadSummary({ squad, accountLabel }: {
  squad: Squad;
  accountLabel: (accountId: string | null, autoAccount: boolean) => string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5 text-[10.5px] text-gray-500 dark:text-white/45">
      <div>{t("squads.lead")}: {squad.lead.agentId}{squad.lead.model ? ` · ${squad.lead.model}` : ""} · {accountLabel(squad.lead.accountId, squad.lead.autoAccount)}</div>
      {squad.members.map((member) => (
        <div key={member.roleId} className="flex justify-between gap-3">
          <span className="font-medium text-gray-700 dark:text-gray-300">{t(`squads.roleNames.${member.roleId}`, { defaultValue: member.roleId })}</span>
          <span className="truncate text-right">
            {member.agentId}{member.model ? ` · ${member.model}` : ""} · {accountLabel(member.accountId, member.autoAccount)}
          </span>
          {member.availability !== "available" && <span className="text-amber-700 dark:text-amber-300">{t(`squads.availability.${member.availability}`)}</span>}
        </div>
      ))}
    </div>
  );
}

const STATE_DOT = {
  working: "bg-emerald-500 animate-pulse",
  waiting_approval: "bg-amber-500 animate-pulse",
  waiting_deps: "bg-gray-400",
  queued: "bg-amber-400",
  done: "bg-accent-500",
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
