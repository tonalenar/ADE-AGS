import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertaToast, Button, CloseIcon } from "neogestify-ui-components";

export type Schedule =
  | { kind: "every"; secs: number }
  | { kind: "daily"; hour: number; minute: number; days: number[] }
  | { kind: "once"; at: number };

export interface Routine {
  id: string;
  name: string;
  text: string;
  targetTab: string | null;
  targetName: string;
  schedule: Schedule;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  lastResult: string;
  runs: number;
}

const DAYS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

/** El horario en palabras, como lo dice `ccode routines`. */
export function describeSchedule(s: Schedule): string {
  if (s.kind === "once") return "uma vez";
  if (s.kind === "every") {
    if (s.secs % 3600 === 0) return `a cada ${s.secs / 3600} h`;
    if (s.secs % 60 === 0) return `a cada ${s.secs / 60} min`;
    return `a cada ${s.secs} s`;
  }
  const at = `às ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  return s.days.length === 0 ? `todo dia ${at}` : `${at} (${s.days.map((d) => DAYS[d]).join(", ")})`;
}

function when(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * Las rotinas, para quien las mira: se prenden, se apagan, se disparan a mano y se borran.
 * Crearlas es de `ccode routine create` (un agente, o el usuario desde un terminal): acá
 * no hay formulario de horarios, solo lo que hace falta para gobernarlas.
 */
export function RoutinesPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<Routine[]>("routine_list_all").then(setRoutines).catch(() => setRoutines([]));
  }, []);

  useEffect(() => {
    load();
    const off = listen("cc-routines-changed", load);
    return () => {
      off.then((fn) => fn());
    };
  }, [load]);

  // Borrar pide un segundo clic.
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const fail = (e: unknown) => AlertaToast(t("canvas.routines.title"), String(e), "error", 6000);

  const toggle = (r: Routine) => invoke("routine_set_enabled", { id: r.id, enabled: !r.enabled }).catch(fail);
  const runNow = async (r: Routine) => {
    setRunning(r.id);
    try {
      await invoke("routine_run_now", { id: r.id });
    } catch (e) {
      fail(e);
    } finally {
      setRunning(null);
    }
  };
  const remove = (r: Routine) => {
    if (armed !== r.id) return setArmed(r.id);
    setArmed(null);
    invoke("routine_remove", { id: r.id }).catch(fail);
  };

  const small = `cc-t h-6 px-2 rounded-md text-[11px] font-medium text-gray-600 dark:text-gray-300
    hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-40`;

  return (
    <div className="pointer-events-auto absolute right-3 bottom-14 w-[26rem] max-h-[60%] flex flex-col rounded-lg
      border border-gray-200 dark:border-white/10 bg-white/98 dark:bg-surface-raised/98 shadow-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-gray-200 dark:border-white/10">
        <span className="text-[12.5px] font-medium text-gray-800 dark:text-gray-100">{t("canvas.routines.title")}</span>
        <span className="flex-1" />
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.routines.close")}
          className="cc-t w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>

      <div className="overflow-y-auto">
        {routines === null ? null : routines.length === 0 ? (
          <p className="px-3 py-4 text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">{t("canvas.routines.empty")}</p>
        ) : (
          routines.map((r) => (
            <div key={r.id} className="px-3 py-2 border-b last:border-b-0 border-gray-100 dark:border-white/6">
              <div className="flex items-center gap-2">
                <span className={`truncate text-[12.5px] font-medium ${r.enabled ? "text-gray-800 dark:text-gray-100" : "text-gray-400 dark:text-gray-500"}`}>
                  {r.name}
                </span>
                <span className="flex-1" />
                <Button variant="custom" className={small} onClick={() => toggle(r)} aria-pressed={r.enabled}>
                  {r.enabled ? t("canvas.routines.on") : t("canvas.routines.off")}
                </Button>
                <Button variant="custom" className={small} disabled={running === r.id} onClick={() => runNow(r)}
                  title={t("canvas.routines.runHint")}>
                  {running === r.id ? "…" : t("canvas.routines.run")}
                </Button>
                <Button variant="custom" onClick={() => remove(r)}
                  className={`cc-t h-6 px-2 rounded-md text-[11px] font-medium
                    ${armed === r.id ? "text-white bg-red-500 hover:bg-red-600" : "text-gray-400 hover:text-red-500"}`}>
                  {armed === r.id ? t("canvas.routines.confirm") : t("canvas.routines.delete")}
                </Button>
              </div>
              <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                {describeSchedule(r.schedule)} · {r.targetTab ? `→ ${r.targetName}` : t("canvas.routines.reminder")}
                {r.enabled && r.nextRun ? ` · ${t("canvas.routines.next")} ${when(r.nextRun)}` : ""}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-gray-400 dark:text-gray-500" title={r.text}>“{r.text}”</div>
              {r.lastRun ? (
                <div className="mt-0.5 text-[10.5px] text-gray-400 dark:text-gray-500">
                  {t("canvas.routines.last")} {when(r.lastRun)} · {r.lastResult}
                </div>
              ) : r.lastResult ? (
                <div className="mt-0.5 text-[10.5px] text-amber-600 dark:text-amber-400">{r.lastResult}</div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
