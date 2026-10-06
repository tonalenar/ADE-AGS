import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, WarningIcon } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { parseBudget } from "./missionView";
import type { BudgetGatedAction, BudgetStatus } from "./budgetTypes";

/**
 * Se abre cuando el presupuesto está excedido y el usuario va a reclutar un subagente o iniciar
 * una tarea. Nunca derriba nada en marcha: elevar el techo o seguir igual (queda registrado).
 */
export function BudgetConfirmDialog({ status, action, onRaise, onContinue, onClose }: {
  status: BudgetStatus;
  action: BudgetGatedAction;
  onRaise: (budgetUsd: number) => void | Promise<void>;
  onContinue: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const suggested = status.budgetUsd !== null ? Math.ceil(status.budgetUsd * 1.5) : 0;
  const [raw, setRaw] = useState(String(suggested));
  const next = parseBudget(raw);
  const canRaise = next !== null && status.budgetUsd !== null && next > status.costUsd && next > status.budgetUsd;
  return (
    <AppDialog
      title={t("missions.budget.confirm.title")}
      size="sm"
      closeOnEsc
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2 px-4 h-12">
          <Button variant="ghost" size="sm" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="secondary" size="sm" onClick={() => onContinue()}>{t("missions.budget.confirm.continue")}</Button>
          <Button variant="primary" size="sm" disabled={!canRaise} onClick={() => next !== null && onRaise(next)}>
            {t("missions.budget.confirm.raise")}
          </Button>
        </div>
      }
    >
      <div className="flex gap-3 items-start py-1">
        <span className="shrink-0 text-amber-500 mt-0.5"><WarningIcon className="w-5 h-5" /></span>
        <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-gray-700 dark:text-gray-300">
          <p>
            {t(`missions.budget.confirm.message.${action}`, {
              cost: status.costUsd.toFixed(2),
              budget: (status.budgetUsd ?? 0).toFixed(2),
            })}
          </p>
          <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("missions.budget.confirm.running")}</p>
          <label className="flex items-center gap-2 text-[11.5px]">
            <span>{t("missions.budget.confirm.newBudget")}</span>
            <input
              value={raw}
              inputMode="decimal"
              onChange={(e) => setRaw(e.target.value)}
              aria-label={t("missions.budget.confirm.newBudget")}
              className="h-7 w-24 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-2 tabular-nums"
            />
          </label>
        </div>
      </div>
    </AppDialog>
  );
}
