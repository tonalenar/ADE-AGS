import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ensureAutomation, hasPaused, resumeAutomation, useAutomation } from "./automation";

/** Os nomes do que ficou pausado, sem repetir (a missão aparece no backend e no Vigia). Pura. */
export function pausedNames(missions: readonly { title: string }[], vigia: Record<string, string>): string[] {
  return [...new Set([...missions.map((m) => m.title), ...Object.values(vigia)])];
}

/**
 * "Automação pausada desde que o app reabriu": o que estava armado antes (missão, time, rotina ou tarefa agendada) não volta
 * sozinho. Só a pessoa retoma, por este botão. `compact` = visual do QG do bot.
 */
export function AutomationResumeBar({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const state = useAutomation();
  const [error, setError] = useState("");
  useEffect(() => ensureAutomation(), []);
  if (!hasPaused(state)) return null;
  const names = pausedNames(state.status?.missions ?? [], state.vigia);
  const routines = state.status?.routines ?? [];
  const scheduledTasks = state.status?.scheduledTasks ?? [];
  const fixRounds = state.status?.interruptedFixRounds ?? 0;
  const shell = compact
    ? "ags-hq__detail"
    : "rounded-xl bg-amber-50 dark:bg-amber-400/10 p-4 ring-1 ring-inset ring-amber-500/30 dark:ring-amber-400/25";
  const line = compact ? "text-[10.5px] text-gray-200" : "text-[11.5px] text-gray-700 dark:text-gray-200";
  return (
    <section className={shell} role="status" aria-label={t("automation.paused.title")}>
      <h3 className={compact ? "mb-1 text-[11px] font-semibold text-amber-300" : "mb-1 text-[12px] font-semibold text-amber-800 dark:text-amber-200"}>
        {t("automation.paused.title")}
      </h3>
      <p className={line}>{t("automation.paused.detail")}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {names.length > 0 && <li className={line}>{t("automation.paused.teams", { names: names.join(", ") })}</li>}
        {routines.length > 0 && <li className={line}>{t("automation.paused.routines", { names: routines.map((r) => r.name).join(", ") })}</li>}
        {scheduledTasks.length > 0 && <li className={line}>{t("automation.paused.scheduledTasks", { names: scheduledTasks.map((task) => task.name).join(", ") })}</li>}
        {fixRounds > 0 && <li className={line}>{t("automation.paused.fixRounds", { count: fixRounds })}</li>}
      </ul>
      <button
        type="button"
        className="mt-2 rounded-md bg-amber-500/90 px-2.5 py-1 text-[11px] font-semibold text-gray-950 hover:bg-amber-400"
        onClick={() => { setError(""); resumeAutomation().catch((e: unknown) => setError(String(e))); }}
      >
        {t("automation.resume")}
      </button>
      {error && <p className="mt-1 text-[11px] text-red-500 dark:text-red-400">{error}</p>}
    </section>
  );
}
