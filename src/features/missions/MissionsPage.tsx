import { HandoffView } from "@/features/runs/HandoffView";
import { MemoryInboxButton } from "@/features/memory/MemoryInbox";
import { MemoryReviewPanel } from "@/features/memory/MemoryReviewPanel";
import { SharedMemoryPanel, type MemoryTab } from "@/features/memory/SharedMemoryPanel";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { FailureNotice } from "./FailureNotice";
import { MissionObjective } from "./MissionObjective";
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
import { BudgetBar } from "./BudgetBar";
import { CleanupPanel } from "./CleanupPanel";
import { BudgetConfirmDialog } from "./BudgetConfirmDialog";
import { continueOverBudget, missionBudget, raiseMissionBudget } from "./budgetIpc";
import { isBudgetConfirmation, type BudgetStatus } from "./budgetTypes";
import { FleetView } from "./FleetView";
import { MissionDialog } from "./MissionDialog";
import { MissionMap } from "./MissionMap";
import { MemoryContextMetricsCard } from "@/features/memory/MemoryContextMetricsCard";
import { MissionTimingsPanel } from "./MissionTimingsPanel";
import { MissionStallAlerts, MissionStartupTime } from "./StallAlertsView";
import { MissionTokensPanel } from "./MissionTokensPanel";
import { startMissionInTerminals } from "./terminals";
import { DuplicateMissionDialog } from "./DuplicateMissionDialog";
import { findDuplicateMission } from "./duplicates";
import { MissionReviewPanel } from "./MissionReviewPanel";
import { MissionFinishDialog } from "./MissionFinishDialog";
import { MissionMetricsCard, MissionTeamCard, capitalize, formatActive, prLabel, prUrl } from "./MissionOverview";
import { agentTile } from "@/features/agents/agentTile";
import * as missionIpc from "./ipc";
import {
  AGENT_STATES, agentStateOf, approvalsFor, blockedRuns, canEdit, countAgentStates, dependencyLabels, emptyForm,
  formFromMission, missionAction, missionPhase, progressOf, workersOf, type MissionPhase, type Progress,
} from "./missionView";
import { useMissionsStore } from "./store";
import type { MissionDetail, MissionSummary, TerminalDeliveryInput } from "./types";

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
  done_without_delivery: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  cancelled: "bg-gray-200 text-gray-500 dark:bg-white/8 dark:text-white/40",
};

/** Grupos da lista (só apresentação): cada um com o rótulo de status que já existe no i18n. */
type GroupKey = "running" | "draft" | "done" | "archived";
const MISSION_GROUPS: { key: GroupKey; labelKey: string }[] = [
  { key: "running", labelKey: "missions.status.running" },
  { key: "draft", labelKey: "missions.status.draft" },
  { key: "done", labelKey: "missions.status.done" },
  { key: "archived", labelKey: "missions.sidebar.archived" },
];
function groupOf(phase: MissionPhase): GroupKey {
  if (phase === "running" || phase === "waiting_approval") return "running";
  if (phase === "draft") return "draft";
  if (phase === "done" || phase === "done_without_delivery") return "done";
  return "archived";
}

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
  // Busca da lista (prancheta 2): filtra só o que aparece, por título e objetivo.
  const [query, setQuery] = useState("");
  const [fleet, setFleet] = useState(false);
  const [focusTab, setFocusTab] = useState<MemoryTab>("workspace");
  const [focusNonce, setFocusNonce] = useState(0);
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const memoryFocus = useRef(false);

  // Ctrl/⌘+F leva à busca da lista (a dica fica dentro do campo, como na prancheta).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const state = location.state as { focusMission?: string | null; memoryTab?: MemoryTab } | null;
    if (!state) return;
    setSelected(state.focusMission ?? null);
    memoryFocus.current = !state.focusMission && !!state.memoryTab;
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

  // Sem nada escolhido, abre a primeira em execução (ou a primeira da lista), como na prancheta.
  // Vindo de "ver memória do workspace", fica no painel de memória.
  useEffect(() => {
    if (selected || memoryFocus.current || !loaded || missions.length === 0) return;
    const first = missions.find((m) => m.status === "running") ?? missions.find((m) => m.status === "draft") ?? missions[0];
    setSelected(first.id);
  }, [selected, loaded, missions]);

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
      <div className="relative flex items-center gap-2 h-[52px] shrink-0 pl-4 pr-14 border-b border-black/[0.08] dark:border-[rgba(84,84,88,0.55)] bg-white/80 dark:bg-[rgba(30,30,32,0.72)] backdrop-blur-xl">
        <span className="pointer-events-none absolute inset-x-0 text-center text-[13px] font-semibold text-gray-900 dark:text-[#f5f5f7]">
          {t("missions.title")} <span className="font-medium text-gray-400 dark:text-white/30">· {missions.length}</span>
        </span>
        <div className="flex-1" />
        <Button variant="custom" size="sm" aria-pressed={fleet} onClick={() => setFleet((v) => !v)}
          className={`px-2.5 h-7 rounded-md text-[12px] font-medium ${fleet ? "bg-accent-500/15 text-accent-700 dark:text-accent-300" : "text-gray-500 dark:text-white/55 hover:text-gray-900 dark:hover:text-white"}`}>
          {t("missions.fleet.title")}
        </Button>
        {workspaceId && <MemoryInboxButton workspaceId={workspaceId} />}
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
        <div className="w-80 shrink-0 cc-scroll border-r border-black/[0.08] dark:border-[rgba(84,84,88,0.55)] bg-gray-50/60 dark:bg-surface px-3 pt-4 pb-3">
          <h1 className="mx-1 mb-3 text-[26px] leading-8 font-semibold tracking-[-0.4px] text-gray-900 dark:text-[#f5f5f7]">{t("missions.title")}</h1>
          {loaded && missions.length === 0 ? (
            <EmptyState
              className="py-16 px-4"
              icon={<LocationIcon className="w-8 h-8" />}
              title={t("missions.empty.title")}
              description={t("missions.empty.desc")}
            />
          ) : (<>
            <label className="sticky top-0 z-10 flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-[10px]
              bg-black/[0.05] dark:bg-surface-raised text-gray-400 dark:text-white/30
              focus-within:ring-[3px] focus-within:ring-accent-500/25">
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" className="h-[15px] w-[15px] shrink-0" aria-hidden><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2 16 16" /></svg>
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("missions.search")}
                aria-label={t("missions.search")}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none" />
              {query && <button type="button" onClick={() => setQuery("")} aria-label={t("btn.clear", { defaultValue: "Limpar" })}
                className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-400/60 text-[10px] text-white">×</button>}
              {!query && <kbd className="shrink-0 rounded-[5px] bg-black/[0.06] dark:bg-surface-overlay px-1.5 py-0.5 font-mono text-[11px] leading-[14px] text-gray-500 dark:text-white/60 shadow-[0_1px_0_rgba(0,0,0,0.4)]">{SEARCH_KEY}</kbd>}
            </label>
            {MISSION_GROUPS.map((group) => {
              const q = query.trim().toLowerCase();
              const rows = missions
                .filter((m) => !q || m.title.toLowerCase().includes(q) || (m.objective ?? "").toLowerCase().includes(q))
                .map((m) => ({ m, phase: missionPhase(m.status, waiting(m)) }))
                .filter(({ phase }) => groupOf(phase) === group.key);
              if (rows.length === 0) return null;
              return (
                <div key={group.key} className="mt-[18px] flex flex-col gap-0.5">
                  <div className="flex items-center justify-between px-2 pb-1.5 text-[11px] leading-[14px] uppercase tracking-[0.06em] text-gray-500 dark:text-white/60">
                    <span>{t(group.labelKey)}</span>
                    <span className="font-mono tabular-nums text-gray-400 dark:text-white/30">{rows.length}</span>
                  </div>
                  {rows.map(({ m, phase }) => (
                    <MissionRow
                      key={m.id}
                      mission={m}
                      squad={squads.find((sq) => sq.id === m.squadId) ?? null}
                      phase={phase}
                      active={m.id === selected}
                      onSelect={() => setSelected(m.id)}
                    />
                  ))}
                </div>
              );
            })}
          </>)}
        </div>

        <div className="flex-1 min-w-0 cc-scroll">
          {fleet ? (
            <FleetView onOpenMission={(id) => { setSelected(id); setFleet(false); }} />
          ) : summary && detail ? (
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
    <span className={`shrink-0 px-2 h-[18px] inline-flex items-center rounded-full text-[10.5px] font-semibold whitespace-nowrap ${STATUS_TONE[phase]}`}>
      {capitalize(t(`missions.status.${phase}`))}
    </span>
  );
}


const SEARCH_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘F" : "Ctrl F";

function MissionRow({ mission, squad, phase, active, onSelect }: {
  mission: MissionSummary;
  squad: Squad | null;
  phase: MissionPhase;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const lead = squad?.lead.agentId ?? mission.leadAgent ?? mission.leadAgentId;
  const who = squad?.name ?? (lead ? lead : t("missions.autoLead"));
  return (
    <Button variant="custom"
      onClick={onSelect}
      aria-pressed={active}
      title={mission.objective}
      className={`cc-t w-full flex flex-col items-stretch px-2.5 py-[9px] text-left rounded-[10px]
        ${active
          ? "bg-accent-500/15 shadow-[inset_0_0_0_0.5px_rgba(10,132,255,0.35)]"
          : "hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"}`}
    >
      <span className="truncate text-[13px] leading-[17px] font-semibold text-gray-900 dark:text-[#f5f5f7]">{mission.title}</span>
      <span className="mt-1 flex items-center gap-2 min-w-0 text-[11px] leading-[14px] text-gray-500 dark:text-white/60">
        <StatusBadge phase={phase} />
        <span className="flex min-w-0 items-center gap-[5px]">
          <i aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-[2px]" style={{ background: lead ? agentTile(lead) : "#8e8e93" }} />
          <span className="truncate">{who}</span>
        </span>
        <span className="ml-auto shrink-0 font-mono tabular-nums text-gray-400 dark:text-white/30">{formatActive(mission.activeSeconds) ?? "—"}</span>
      </span>
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
  const allMissions = useMissionsStore((s) => s.missions);
  const duplicate = useMemo(() => findDuplicateMission(allMissions, mission), [allMissions, mission]);
  const [duplicateTarget, setDuplicateTarget] = useState<{ id: string; title: string; status: string; isRunning: boolean } | null>(null);

  const [budgetPrompt, setBudgetPrompt] = useState<{ status: BudgetStatus; kind: "start" | "retry"; force: boolean } | null>(null);

  const act = async (kind: "start" | "retry" | "cancel", force = false) => {
    if (!workspaceId) return;
    if (kind !== "cancel" && !force && duplicate) {
      setDuplicateTarget({
        id: duplicate.mission.id,
        title: duplicate.mission.title,
        status: duplicate.mission.status,
        isRunning: duplicate.isRunning,
      });
      return;
    }
    setBusy(true);
    onError("");
    try {
      const store = useMissionsStore.getState();
      if (kind === "cancel") {
        await store.cancel(workspaceId, mission.id);
      } else {
        // Iniciar abre el equipo en terminales reales en el canvas de la misión.
        await startMissionInTerminals(mission, squad ?? null, roles, { force });
        await store.load(workspaceId).catch(() => undefined);
        navigate("/workspace");
      }
    } catch (e) {
      if (kind !== "cancel" && isBudgetConfirmation(e)) {
        // Presupuesto excedido: se pide confirmación (nunca se frena a los agentes en marcha).
        try {
          setBudgetPrompt({ status: await missionBudget(mission.id), kind, force });
          return;
        } catch { /* sin estado no se puede confirmar: cae al mensaje de abajo */ }
      }
      const problem = String(e);
      onError(t(problem, { defaultValue: problem }));
    } finally {
      setBusy(false);
    }
  };

  const confirmBudget = async (apply: () => Promise<unknown>) => {
    const prompt = budgetPrompt;
    if (!prompt) return;
    try {
      await apply();
      setBudgetPrompt(null);
      await act(prompt.kind, prompt.force);
    } catch (e) {
      setBudgetPrompt(null);
      onError(String(e));
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
  // Missão em terminais (sem run): conclui-se informando testes e PR.
  const runless = mission.status === "running" && mission.activeRunId === null;
  const [finishing, setFinishing] = useState(false);
  const finish = async (delivery: TerminalDeliveryInput) => {
    if (!workspaceId) return;
    await missionIpc.finishMissionTerminals(mission.id, delivery);
    await useMissionsStore.getState().load(workspaceId).catch(() => undefined);
    await useMissionsStore.getState().loadDetail(mission.id).catch(() => undefined);
  };
  const squadName = run?.squadName ?? squad?.name ?? null;
  const leadAgentId = lead?.agentId ?? squad?.lead.agentId ?? mission.leadAgentId;
  const branch = lead?.branch ?? tasks.find((task) => task.branch)?.branch ?? null;
  const pr = detail.delivery?.pullRequest ?? null;
  const activeText = formatActive(summary.activeSeconds);
  const metaIcon = "h-[15px] w-[15px] shrink-0 text-gray-400 dark:text-white/30";
  const metaItems = ([
    squadName ? { key: "squad", node: <>
      <span aria-hidden className="h-4 w-4 shrink-0 rounded" style={{ background: leadAgentId ? agentTile(leadAgentId) : "#8e8e93" }} />
      <span className="truncate">{t("missions.squadLabel", { name: squadName })}</span>
    </> } : null,
    branch ? { key: "branch", node: <>
      <svg viewBox="0 0 18 18" aria-hidden className={metaIcon} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><circle cx="5" cy="4" r="1.7" /><circle cx="5" cy="14" r="1.7" /><circle cx="13" cy="6" r="1.7" /><path d="M5 5.7v6.6" /><path d="M13 7.7c0 2.9-8 1.9-8 4.6" /></svg>
      <span className="truncate font-mono text-gray-900 dark:text-[#f5f5f7]">{branch}</span>
    </> } : { key: "cwd", node: <span className="truncate font-mono text-gray-900 dark:text-[#f5f5f7]" title={mission.cwd}>{mission.cwd}</span> },
    pr ? { key: "pr", node: <>
      <svg viewBox="0 0 18 18" aria-hidden className={metaIcon} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><circle cx="5" cy="4" r="1.7" /><circle cx="5" cy="14" r="1.7" /><circle cx="13" cy="14" r="1.7" /><path d="M5 5.7v6.6" /><path d="M13 12.3V7a2.5 2.5 0 0 0-2.5-2.5H9" /><path d="M10.4 3.2 9 4.5l1.4 1.3" /></svg>
      {prUrl(pr)
        ? <a href={prUrl(pr)!} target="_blank" rel="noreferrer" className="font-medium text-accent-600 hover:underline dark:text-accent-400">{prLabel(pr)}</a>
        : <span className="font-medium text-accent-600 dark:text-accent-400">{prLabel(pr)}</span>}
    </> } : null,
    activeText ? { key: "time", node: <>
      <svg viewBox="0 0 18 18" aria-hidden className={metaIcon} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><circle cx="9" cy="9" r="6.5" /><path d="M9 5.4V9l2.4 1.6" /></svg>
      <span className="font-mono tabular-nums text-gray-900 dark:text-[#f5f5f7]">{activeText}</span>
    </> } : null,
  ] as ({ key: string; node: React.ReactNode } | null)[]).filter((item): item is { key: string; node: React.ReactNode } => item !== null);

  return (
    <div className="flex flex-col gap-5 px-8 py-6">
      <div className="flex items-start gap-6">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] leading-[14px] uppercase tracking-[0.06em] text-gray-500 dark:text-white/60">
            {t("missions.eyebrow", { status: t(`missions.status.${phase}`) })}
          </div>
          <h2 className="mt-1.5 text-[26px] leading-8 font-semibold tracking-[-0.4px] text-gray-900 dark:text-[#f5f5f7] [overflow-wrap:anywhere]">{mission.title}</h2>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] leading-[17px] text-gray-500 dark:text-white/60">
            {metaItems.map((item, i) => (
              <span key={item.key} className="flex min-w-0 items-center gap-4">
                {i > 0 && <span aria-hidden className="h-3 w-px bg-black/[0.12] dark:bg-[rgba(84,84,88,0.55)]" />}
                <span className="flex min-w-0 items-center gap-1.5">{item.node}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-2">
          {canEdit(mission.status) && (
            <Button variant="custom" onClick={onEdit} disabled={busy} className="h-7 inline-flex items-center gap-1.5 rounded-[7px] px-3.5 text-[13px] font-medium whitespace-nowrap bg-white dark:bg-surface-raised text-gray-900 dark:text-[#f5f5f7] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.12)] dark:shadow-[inset_0_0_0_0.5px_rgba(84,84,88,0.55),0_1px_2px_rgba(0,0,0,0.3)] disabled:opacity-50">{t("missions.edit")}</Button>
          )}
          {action === "cancel" && (
            <Button variant="custom" onClick={() => act("cancel")} disabled={busy} className="h-7 inline-flex items-center gap-1.5 rounded-[7px] px-3.5 text-[13px] font-medium whitespace-nowrap bg-white dark:bg-surface-raised text-gray-900 dark:text-[#f5f5f7] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.12)] dark:shadow-[inset_0_0_0_0.5px_rgba(84,84,88,0.55),0_1px_2px_rgba(0,0,0,0.3)] disabled:opacity-50">
              {busy && <AnimateSpin className="w-3.5 h-3.5" />}
              {t("missions.action.cancel")}
            </Button>
          )}
          {runless && (
            <Button variant="custom" onClick={() => setFinishing(true)} disabled={busy} className="h-7 inline-flex items-center gap-1.5 rounded-[7px] px-3.5 text-[13px] font-medium whitespace-nowrap bg-accent-500 hover:bg-accent-600 text-white shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_0.5px_0_rgba(255,255,255,0.2)] disabled:opacity-50">
              <svg viewBox="0 0 18 18" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M4 9.5l3.2 3.2L14 5.8" /></svg>
              {t("missions.finishAction")}
            </Button>
          )}
          {action && action !== "cancel" && (
            <Button variant="custom" onClick={() => act(action)}
              disabled={busy || unavailableSquad || unsupportedLead} className="h-7 inline-flex items-center gap-1.5 rounded-[7px] px-3.5 text-[13px] font-medium whitespace-nowrap bg-accent-500 hover:bg-accent-600 text-white shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_0.5px_0_rgba(255,255,255,0.2)] disabled:opacity-50">
              {busy && <AnimateSpin className="w-3.5 h-3.5" />}
              {t(`missions.action.${action}`)}
            </Button>
          )}
        </div>
      </div>

      {budgetPrompt && (
        <BudgetConfirmDialog
          status={budgetPrompt.status}
          action="startTask"
          onClose={() => setBudgetPrompt(null)}
          onRaise={(usd) => confirmBudget(() => raiseMissionBudget(mission.id, usd))}
          onContinue={() => confirmBudget(() => continueOverBudget(mission.id, "startTask"))}
        />
      )}

      {duplicate && (
        <Alert variant="warning">
          {duplicate.isRunning
            ? t("missions.duplicate.bannerRunning", { title: duplicate.mission.title })
            : t("missions.duplicate.bannerRecent", { title: duplicate.mission.title })}
        </Alert>
      )}
      {mission.status === "draft" && <Alert variant="info">{t("missions.draftNotice")}</Alert>}
      {mission.status === "failed" && <FailureNotice mission={mission} />}
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


      <MissionObjective key={mission.id} objective={mission.objective} title={t("missions.detail.objective")} />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <MissionTeamCard mission={mission} tasks={tasks} squad={squad} blocked={blockedTasks} />
        <MissionMetricsCard summary={summary} mission={mission} delivery={detail.delivery} />
      </div>

      {detail.delivery && (
        <Section title={t("missions.delivery.title")}>
          <div className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-gray-300">
            <span>{t("missions.delivery.tests", { result: t(`missions.delivery.test.${detail.delivery.testResult}`) })}</span>
            <span>{t("missions.delivery.ci", { result: t(`missions.delivery.ci.${detail.delivery.ciStatus}`) })}</span>
            <span>{t("missions.delivery.checkedAt", { date: new Date(detail.delivery.checkedAt * 1000).toLocaleString() })}</span>
            {detail.delivery.pullRequest && (
              <span className="break-all">{t("missions.delivery.pr")}: {detail.delivery.pullRequest}</span>
            )}
          </div>
        </Section>
      )}
      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-px overflow-hidden rounded-xl bg-black/[0.06] dark:bg-white/[0.07] ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.07]">
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

      {mission.status !== "draft" && <BudgetBar missionId={mission.id} />}

      <MissionMap tasks={tasks} accountLabel={accountLabel} />

      {mission.status === "draft" && (
        <Section title={t("missions.autonomy.title")}>
          <AutonomyPicker />
        </Section>
      )}

      {mission.status !== "draft" && (
        <Section title={t("missions.timings.title")}>
          <div className="flex flex-col gap-3">
            <MissionStallAlerts missionId={mission.id} />
            <MissionStartupTime missionId={mission.id} />
            <MissionTimingsPanel missionId={mission.id} />
            <MemoryContextMetricsCard missionId={mission.id} />
          </div>
        </Section>
      )}

      {mission.status !== "draft" && (
        <Section title={t("missions.tokens.title")}>
          <MissionTokensPanel missionId={mission.id} />
        </Section>
      )}

      {(mission.status === "done" || mission.status === "cancelled" || mission.status === "failed") && (
        <Section title={t("missions.cleanup.title")}>
          <CleanupPanel missionId={mission.id} />
        </Section>
      )}

      {tasks.length > 0 && (
        <Section title={t("missions.detail.tasks")}>
          <ul className="flex flex-col divide-y divide-black/[0.06] dark:divide-white/[0.07] overflow-hidden rounded-xl bg-gray-50 dark:bg-surface ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.07]">
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

      {workspaceId && <MemoryReviewPanel missionId={mission.id} workspaceId={workspaceId} refreshKey={mission.status} />}
      {workspaceId && <SharedMemoryPanel key={`${workspaceId}-${mission.id}-${focusNonce}`} workspaceId={workspaceId} missionId={mission.id} runs={runs} activeRunId={mission.activeRunId} initialTab={focusTab} />}
      {finishing && <MissionFinishDialog onClose={() => setFinishing(false)} onFinish={finish} />}
      {duplicateTarget && (
        <DuplicateMissionDialog
          duplicate={duplicateTarget}
          onClose={() => setDuplicateTarget(null)}
          onConfirm={() => {
            setDuplicateTarget(null);
            if (action) void act(action, true);
          }}
        />
      )}
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
    <li className="flex flex-col gap-1 px-4 py-2.5">
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
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-[11px] font-medium uppercase tracking-[0.06em] text-gray-500 dark:text-white/45">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 min-w-0 px-4 py-3 bg-gray-50 dark:bg-surface">
      <dt className="text-[11px] text-gray-500 dark:text-white/45">{label}</dt>
      <dd className="truncate font-mono text-[17px] leading-6 font-semibold tabular-nums tracking-[-0.01em] text-gray-900 dark:text-gray-50" title={value}>{value}</dd>
    </div>
  );
}
