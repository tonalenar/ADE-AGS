import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { alertKey, startupSummary, useStallAlerts, waitLabel, type StallAlert, type StartupTime } from "./stallAlerts";
import { formatDuration } from "./timings";

const EMPTY: StallAlert[] = [];

/** Relógio que só corre enquanto há alerta, para a espera crescer na tela. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Alertas de orquestrador parado / agente ocioso. `compact` = visual do QG do bot. */
export function StallAlertsBanner({ alerts, compact = false, now: fixedNow }: { alerts: readonly StallAlert[]; compact?: boolean; now?: number }) {
  const { t } = useTranslation();
  const ticking = useNow(alerts.length > 0 && fixedNow === undefined);
  const now = fixedNow ?? ticking;
  if (alerts.length === 0) return null;
  const shell = compact
    ? "ags-hq__detail"
    : "rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-400/30 dark:bg-amber-400/10";
  return (
    <section className={shell} role="alert" aria-label={t("missions.stall.title")}>
      <h3 className={compact ? "mb-1 text-[11px] font-semibold text-amber-300" : "mb-1 text-[11px] font-semibold text-amber-800 dark:text-amber-200"}>
        {t("missions.stall.title")}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {alerts.map((a) => (
          <li key={`${a.memberName}-${a.kind}`} className={compact ? "text-[10.5px] text-gray-200" : "text-[11.5px] text-gray-700 dark:text-gray-200"}>
            {t(alertKey(a.kind), { name: a.memberName, time: waitLabel(a, now) })}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Tempo até todos trabalhando" da missão. */
export function StartupTimeLine({ startup, compact = false }: { startup: StartupTime | null | undefined; compact?: boolean }) {
  const { t } = useTranslation();
  const s = startupSummary(startup);
  const cls = compact ? "ags-hq__dim" : "text-[11.5px] text-gray-500 dark:text-gray-400";
  const text = s.state === "done"
    ? t("missions.startup.done", { time: formatDuration(s.ms ?? 0) })
    : s.state === "waiting"
      ? t("missions.startup.waiting", { names: s.pending.join(", ") })
      : t("missions.startup.unknown");
  return <p className={cls}>{text}</p>;
}

/** Ligados à store: aba da missão e QG usam estes. */
export function MissionStallAlerts({ missionId, compact = false }: { missionId: string; compact?: boolean }) {
  const alerts = useStallAlerts((s) => s.alerts[missionId] ?? EMPTY);
  return <StallAlertsBanner alerts={alerts} compact={compact} />;
}

export function MissionStartupTime({ missionId, compact = false }: { missionId: string; compact?: boolean }) {
  const startup = useStallAlerts((s) => s.startup[missionId]);
  return <StartupTimeLine startup={startup} compact={compact} />;
}
