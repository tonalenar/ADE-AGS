import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useTabsStore } from "@/features/tabs/store";

import { openFree, openMission, tabsByMission, useActiveGroup, useMissionIndex } from "./groups";
import { useMissionsStore } from "./store";

const CHIP = `cc-t shrink-0 flex items-center gap-1.5 h-6 px-2.5 rounded-md text-[11.5px] font-medium whitespace-nowrap`;

/**
 * La parte de arriba de la barra: una pestaña por misión con terminales abiertas, y "todas"
 * para lo suelto. Las terminales de cada misión quedan agrupadas adentro (la tira de abajo
 * muestra solo las del grupo que se mira).
 */
export function MissionChips() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const missions = useMissionsStore((s) => s.missions);
  const tabs = useTabsStore((s) => s.tabs);
  const index = useMissionIndex();
  const group = useActiveGroup();
  const open = useMemo(() => tabsByMission(index, tabs), [index, tabs]);

  // Solo las que tienen terminales abiertas: una misión sin pestañas no tiene qué mostrar acá.
  const shown = missions.filter((m) => (open[m.id]?.length ?? 0) > 0);
  if (shown.length === 0) return null;
  const free = tabs.filter((tab) => !index[tab.id]).length;

  const style = (active: boolean) =>
    active
      ? "bg-white dark:bg-white/12 text-gray-900 dark:text-white shadow-sm"
      : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-white/6";

  return (
    <div className="flex items-center gap-1 px-2 shrink-0" data-tauri-drag-region="false">
      <button type="button" className={`${CHIP} ${style(group === null)}`}
        onClick={() => { if (openFree()) navigate("/workspace"); }}>
        {t("missions.chips.all")}
        {free > 0 && <span className="text-[10px] tabular-nums opacity-60">{free}</span>}
      </button>
      {shown.map((m) => (
        <button key={m.id} type="button" className={`${CHIP} ${style(group === m.id)}`} title={m.objective}
          onClick={() => { if (openMission(m.id)) navigate("/workspace"); }}>
          <span className={`w-1.5 h-1.5 rounded-full ${m.status === "running" ? "bg-emerald-500" : "bg-gray-400"}`} />
          <span className="max-w-40 truncate">{m.title}</span>
          <span className="text-[10px] tabular-nums opacity-60">{open[m.id]?.length}</span>
        </button>
      ))}
      <span className="w-px h-5 mx-1 bg-gray-200 dark:bg-white/10" />
    </div>
  );
}
