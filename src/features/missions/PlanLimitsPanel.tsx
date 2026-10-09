import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { planLimits } from "./budgetIpc";
import { nearLimit, type PlanLimits } from "./budgetTypes";
import { dateLocale } from "@/i18n/dateLocale";

/** Solo lectura de las ventanas de uso de cada plan; sin datos expuestos = «no medido», en gris. */
export function PlanLimitsView({ limits }: { limits: PlanLimits[] }) {
  const { t } = useTranslation();
  if (limits.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="plan-limits">
      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-white/30">{t("missions.plan.title")}</span>
      {limits.map((l) => (
        <div key={`${l.provider}-${l.accountId ?? ""}`} className="flex flex-col gap-0.5">
          <span className="text-[11px] font-medium text-gray-700 dark:text-gray-200">
            {t(`missions.plan.provider.${l.provider}`)}
            {l.observedAt != null && (
              <span className="ml-2 font-normal text-[10px] text-gray-400 dark:text-white/35" title={t("missions.plan.observedHint")}>
                {t("missions.plan.observed", { at: new Date(l.observedAt * 1000).toLocaleString(dateLocale()) })}
              </span>
            )}
          </span>
          {!l.measured || l.windows.length === 0 ? (
            <span className="text-[10.5px] text-gray-400 dark:text-white/35">{t("missions.plan.unmeasured")}</span>
          ) : (
            l.windows.map((w) => (
              <div key={w.label} className="flex items-center gap-2 text-[10.5px] tabular-nums">
                <span className="w-14 shrink-0 text-gray-500 dark:text-white/45">{w.label}</span>
                {w.usedPct === null ? (
                  <span className="text-gray-400 dark:text-white/35">{t("missions.plan.unmeasured")}</span>
                ) : (
                  <>
                    <span className="h-1.5 flex-1 rounded-full overflow-hidden bg-gray-200 dark:bg-white/10">
                      <span className={`block h-full ${nearLimit(w) ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, Math.max(0, w.usedPct))}%` }} />
                    </span>
                    <span className={nearLimit(w) ? "text-amber-700 dark:text-amber-300" : "text-gray-500 dark:text-white/45"}>{Math.round(w.usedPct)}%</span>
                  </>
                )}
                {w.resetsAt && <span className="text-gray-400 dark:text-white/35">{t("missions.plan.resets", { at: new Date(w.resetsAt).toLocaleString(dateLocale()) })}</span>}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

export function PlanLimitsPanel() {
  const [limits, setLimits] = useState<PlanLimits[]>([]);
  useEffect(() => {
    let stale = false;
    const load = () => planLimits().then((l) => { if (!stale) setLimits(l); }).catch(() => { if (!stale) setLimits([]); });
    load();
    const timer = setInterval(load, 120_000);
    return () => { stale = true; clearInterval(timer); };
  }, []);
  return <PlanLimitsView limits={limits} />;
}
