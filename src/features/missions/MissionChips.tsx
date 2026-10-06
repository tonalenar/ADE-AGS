import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { deriveMissionIndicator } from "@/features/tabs/missionIndicator";
import { MissionTabIndicator } from "@/features/tabs/MissionTabIndicator";
import { useMissionIndicatorSignals } from "@/features/tabs/useMissionIndicatorSignals";
import { useTabsStore } from "@/features/tabs/store";
import { AppDialog } from "@/shared/ui/AppDialog";
import { Button } from "neogestify-ui-components";

import { closeMissionNeedsConfirm, openFree, openMission, tabsByMission, useActiveGroup, useMissionIndex } from "./groups";
import { useMissionsStore } from "./store";

const CHIP = `cc-t shrink-0 flex items-center gap-1.5 h-6 px-2.5 rounded-md text-[11.5px] font-medium whitespace-nowrap`;

function ChipIndicator({ missionId }: { missionId: string }) {
  const signals = useMissionIndicatorSignals(missionId);
  return <MissionTabIndicator {...deriveMissionIndicator(signals)} />;
}

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
  const closeTab = useTabsStore((s) => s.closeTab);
  const [closing, setClosing] = useState<string | null>(null);

  const closeMission = (id: string) => (open[id] ?? []).forEach((tabId) => closeTab(tabId));
  const requestClose = (id: string) => {
    if (closeMissionNeedsConfirm(missions.find((m) => m.id === id)?.status)) setClosing(id);
    else closeMission(id);
  };
  const closingMission = missions.find((m) => m.id === closing);

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
        <div key={m.id} className={`group/chip ${CHIP} ${style(group === m.id)} pr-1`}>
          <button type="button" className="flex items-center gap-1.5 h-full" title={m.objective}
            onClick={() => { if (openMission(m.id)) navigate("/workspace"); }}>
            <ChipIndicator missionId={m.id} />
            <span className="max-w-40 truncate">{m.title}</span>
            <span className="text-[10px] tabular-nums opacity-60">{open[m.id]?.length}</span>
          </button>
          <Button variant="icon" title={t("missions.chips.close")} aria-label={t("missions.chips.close")}
            onClick={(e) => { e.stopPropagation(); requestClose(m.id); }}
            className="shrink-0 flex items-center justify-center w-4 h-4 rounded p-0 text-gray-400 hover:text-gray-700
              dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/15">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </Button>
        </div>
      ))}
      <span className="w-px h-5 mx-1 bg-gray-200 dark:bg-white/10" />
      {closing && (
        <AppDialog title={t("missions.chips.closeTitle")} size="sm" closeOnEsc onClose={() => setClosing(null)}
          footer={<>
            <Button variant="outline" onClick={() => setClosing(null)}>{t("btn.cancel")}</Button>
            <Button variant="danger" onClick={() => { closeMission(closing); setClosing(null); }}>{t("missions.chips.closeConfirm")}</Button>
          </>}>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("missions.chips.closeBody", { name: closingMission?.title ?? "" })}</p>
        </AppDialog>
      )}
    </div>
  );
}


