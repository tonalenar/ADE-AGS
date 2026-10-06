import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { MissionTabIndicator } from "@/features/tabs/MissionTabIndicator";
import { deriveMissionIndicator } from "@/features/tabs/missionIndicator";
import { useMissionIndicatorSignals } from "@/features/tabs/useMissionIndicatorSignals";
import { sustainedTabIds } from "@/features/terminal/activity";
import { useTaskActivity } from "@/shared/bus";

import { fleetGroups, type FleetGroup } from "./fleet";
import { missionIndex } from "./groups";
import { useMissionsStore } from "./store";

/**
 * La flota entera: las tareas y terminales activas de TODAS las misiones en curso, agrupadas
 * por misión. El estado de cada grupo sale del mismo muestreador del indicador de pestañas
 * (`useMissionIndicatorSignals`) y el de cada tarea, de la actividad en vivo del bus.
 */
export function FleetView({ onOpenMission }: { onOpenMission: (missionId: string) => void }) {
  const { t } = useTranslation();
  const missions = useMissionsStore((s) => s.missions);
  const details = useMissionsStore((s) => s.details);
  const loadDetail = useMissionsStore((s) => s.loadDetail);
  const tabs = useTabsStore((s) => s.tabs);
  const boards = useCanvasStore((s) => s.boards);
  const [now, setNow] = useState(() => Date.now());

  // El detalle (las tareas) solo se carga al abrir una misión: acá se pide el de las que corren.
  const runningKey = missions.filter((m) => m.status === "running").map((m) => m.id).join("|");
  useEffect(() => {
    for (const id of runningKey ? runningKey.split("|") : []) loadDetail(id).catch(console.error);
  }, [runningKey, loadDetail]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const groups = useMemo(() => fleetGroups({
    missions,
    tasksByMission: Object.fromEntries(Object.entries(details).map(([id, d]) => [id, d.tasks])),
    tabs,
    missionIndex: missionIndex(boards, tabs),
    sustainedTabIds: sustainedTabIds(now),
  }), [missions, details, tabs, boards, now]);

  if (groups.length === 0) {
    return <p className="p-6 text-[12px] text-gray-400 dark:text-white/35">{t("missions.fleet.empty")}</p>;
  }
  return (
    <div className="flex flex-col gap-4 p-5">
      <p className="text-[11px] text-gray-500 dark:text-white/45">{t("missions.fleet.hint")}</p>
      {groups.map((g) => <FleetGroupCard key={g.missionId} group={g} onOpen={() => onOpenMission(g.missionId)} />)}
    </div>
  );
}

function FleetGroupCard({ group, onOpen }: { group: FleetGroup; onOpen: () => void }) {
  const { t } = useTranslation();
  const signals = useMissionIndicatorSignals(group.missionId);
  const { state, workingCount } = deriveMissionIndicator(signals);
  const activity = useTaskActivity(useMemo(() => group.tasks.map((task) => task.id), [group.tasks]));
  const empty = group.tasks.length === 0 && group.terminals.length === 0;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-gray-200 dark:border-white/8 p-3" data-testid={`fleet-group-${group.missionId}`}>
      <button type="button" onClick={onOpen} className="flex items-center gap-2 text-left min-w-0" title={t("missions.fleet.open")}>
        <MissionTabIndicator state={state} workingCount={workingCount} />
        <span className="truncate text-[12.5px] font-semibold text-gray-900 dark:text-white">{group.title}</span>
        <span className="shrink-0 text-[10.5px] text-gray-500 dark:text-white/45">
          {t(`missions.indicator.${state}`, { count: workingCount })}
        </span>
      </button>
      {empty && <p className="text-[11px] text-gray-400 dark:text-white/35">{t("missions.fleet.nothingActive")}</p>}
      <ul className="flex flex-col gap-1">
        {group.tasks.map((task) => {
          const act = activity[task.id];
          const live = task.status === "running" && act && act.kind !== "finished" ? act.label : null;
          return (
            <li key={task.id} className="flex items-center gap-2 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.status === "running" ? "bg-emerald-500 animate-pulse" : "bg-gray-400"}`} />
              <span className="truncate font-medium text-gray-800 dark:text-gray-100">{task.planKey ?? task.title}</span>
              <span className="truncate text-gray-500 dark:text-white/45">{task.model ? `${task.agentId} · ${task.model}` : task.agentId}</span>
              <span className="ml-auto truncate text-emerald-600 dark:text-emerald-400">{live ?? t(`missions.fleet.task.${task.status}`)}</span>
            </li>
          );
        })}
        {group.terminals.map((term) => (
          <li key={term.tabId} className="flex items-center gap-2 text-[11px]">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${term.working ? "bg-emerald-500 animate-pulse" : "bg-gray-400"}`} />
            <span className="truncate font-medium text-gray-800 dark:text-gray-100">{term.title}</span>
            <span className="truncate text-gray-500 dark:text-white/45">{term.agentLabel}</span>
            <span className="ml-auto text-gray-500 dark:text-white/45">{term.working ? t("missions.fleet.working") : t("missions.fleet.idle")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
