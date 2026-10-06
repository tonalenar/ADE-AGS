import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { missionBudget } from "./budgetIpc";
import type { BudgetLevel, BudgetStatus } from "./budgetTypes";

const FILL: Record<BudgetLevel, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  exceeded: "bg-red-500",
};
const TEXT: Record<BudgetLevel, string> = {
  ok: "text-gray-600 dark:text-gray-300",
  warning: "text-amber-700 dark:text-amber-300",
  exceeded: "text-red-600 dark:text-red-400",
};

/** Ancho de la barra: 0-100, y vacía si no se pudo medir. Pura. */
export const barWidth = (s: Pick<BudgetStatus, "pct">): number =>
  s.pct === null || !Number.isFinite(s.pct) ? 0 : Math.max(0, Math.min(100, s.pct));

/** La barra de presupuesto, por props: la reutilizan el QG y la pestaña de la misión. */
export function BudgetBarView({ status }: { status: BudgetStatus }) {
  const { t } = useTranslation();
  if (status.budgetUsd === null) {
    return <p className="text-[11px] text-gray-400 dark:text-white/35">{t("missions.budget.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-1" data-testid="budget-bar" data-level={status.level}>
      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className={`font-semibold ${TEXT[status.level]}`}>{t(`missions.budget.level.${status.level}`)}</span>
        <span className="text-gray-500 dark:text-white/45">
          {`US$ ${status.costUsd.toFixed(2)} / US$ ${status.budgetUsd.toFixed(2)}`}
          {status.pct !== null && ` · ${Math.round(status.pct)}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barWidth(status))}
        className="h-1.5 rounded-full overflow-hidden bg-gray-200 dark:bg-white/10"
      >
        <div className={`h-full ${FILL[status.level]}`} style={{ width: `${barWidth(status)}%` }} />
      </div>
      {status.unpricedModels.length > 0 && (
        <p className="text-[10.5px] text-amber-700 dark:text-amber-300">
          {t("missions.budget.unpriced", { models: status.unpricedModels.join(", ") })}
        </p>
      )}
      {status.unmeasuredAgents.length > 0 && (
        <p className="text-[10.5px] text-gray-400 dark:text-white/35">
          {t("missions.budget.unmeasured", { agents: status.unmeasuredAgents.join(", ") })}
        </p>
      )}
      {status.level === "exceeded" && status.continueAnyway && (
        <p className="text-[10.5px] text-gray-500 dark:text-white/45">{t("missions.budget.continuing")}</p>
      )}
    </div>
  );
}

/**
 * Lee el estado del guarda y lo mantiene al día (`cc-budget-changed` + relectura lenta, porque los
 * tokens medidos no emiten evento). Si el comando no responde, no muestra nada: nunca inventa.
 */
export function useBudgetStatus(missionId: string): BudgetStatus | null {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  useEffect(() => {
    let stale = false;
    const load = () => missionBudget(missionId).then((s) => { if (!stale) setStatus(s); }).catch(() => { if (!stale) setStatus(null); });
    load();
    const timer = setInterval(load, 60_000);
    const off = listen<{ missionId: string }>("cc-budget-changed", (e) => { if (e.payload?.missionId === missionId) load(); });
    return () => {
      stale = true;
      clearInterval(timer);
      off.then((f) => f()).catch(() => {});
    };
  }, [missionId]);
  return status;
}

export function BudgetBar({ missionId }: { missionId: string }) {
  const status = useBudgetStatus(missionId);
  return status ? <BudgetBarView status={status} /> : null;
}
