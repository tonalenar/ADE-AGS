import { useState } from "react";
import { useTranslation } from "react-i18next";

import { RoutinesPanel } from "@/features/canvas/RoutinesPanel";
import { ScheduledTasksPanel } from "@/features/canvas/ScheduledTasksPanel";
import { SettingsSection, SettingsSubTabs } from "@/features/settings/SettingsSection";

type ScheduleTab = "routines" | "tasks";

/**
 * Tarefas agendadas nas Configurações: as rotinas e as tarefas agendadas que o canvas já tem, em modo
 * embutido. Não há lógica nova aqui: são os mesmos painéis que o canvas (`CanvasSchedulesPanel`) abre
 * em um cartão flutuante.
 */
export function ScheduledTasksSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ScheduleTab>("routines");
  return (
    <SettingsSection title={t("settings.scheduled.title")} description={t("settings.scheduled.desc")}>
      <SettingsSubTabs<ScheduleTab>
        items={[
          { id: "routines", label: t("canvas.scheduledTasks.routinesTab") },
          { id: "tasks", label: t("canvas.scheduledTasks.tasksTab") },
        ]}
        value={tab}
        onChange={setTab}
      />
      {/* No modo embutido o painel de rotinas não tem botão de fechar: a prop fica sem efeito. */}
      {tab === "routines"
        ? <RoutinesPanel embedded onClose={() => setTab("routines")} />
        : <ScheduledTasksPanel embedded />}
    </SettingsSection>
  );
}
