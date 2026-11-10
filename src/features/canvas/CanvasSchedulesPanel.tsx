import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon } from "neogestify-ui-components";

import { useDockWidth } from "./dockWidth";
import { RoutinesPanel } from "./RoutinesPanel";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";

type SchedulePanelTab = "routines" | "tasks";

export function CanvasSchedulesPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SchedulePanelTab>("routines");
  const dockWidth = useDockWidth((state) => state.width);

  return (
    <div className="pointer-events-auto absolute right-3 bottom-[4.75rem] w-[26rem] min-h-[16rem] max-h-[70%] flex flex-col rounded-xl
      border border-gray-200 dark:border-white/10 bg-white/98 dark:bg-surface-raised/98 shadow-lg overflow-hidden"
      style={dockWidth > 0 ? { width: dockWidth } : undefined}>
      <div className="flex items-center gap-2 px-2.5 h-10 shrink-0 border-b border-gray-200 dark:border-white/10">
        <div role="tablist" aria-label={t("canvas.scheduledTasks.panelTabs")} className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-white/6 p-0.5">
          {(["routines", "tasks"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
              className={`cc-t h-7 rounded-md px-2.5 text-[11px] font-medium ${tab === value
                ? "bg-white dark:bg-white/15 text-gray-800 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"}`}>
              {value === "routines" ? t("canvas.scheduledTasks.routinesTab") : t("canvas.scheduledTasks.tasksTab")}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.routines.close")}
          className="cc-t w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>
      {tab === "routines"
        ? <RoutinesPanel embedded onClose={onClose} />
        : <ScheduledTasksPanel embedded />}
    </div>
  );
}
