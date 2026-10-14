import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertaToast, Button, CloseIcon } from "neogestify-ui-components";
import { dateLocale } from "@/i18n/dateLocale";
import { useTabsStore } from "@/features/tabs/store";
import { boardKeyOfTab, useActiveBoardKey } from "./store";
import { useDockWidth } from "./dockWidth";
import {
  MAX_NAME,
  MAX_TEXT,
  checkDraft,
  describeSchedule,
  emptyDraft,
  normalizeText,
  relativeFrom,
  summarize,
  toLocalInput,
  type Draft,
  type DraftErrors,
  type Routine,
} from "./routineModel";

export { describeSchedule } from "./routineModel";
export type { Routine, Schedule } from "./routineModel";

function when(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Os agentes abertos neste canvas (as tabs de agente, sem o shell). */
function useCanvasAgents(): { id: string; name: string }[] {
  const boardKey = useActiveBoardKey();
  const tabs = useTabsStore((s) => s.tabs);
  return useMemo(
    () =>
      tabs
        .filter((tab) => tab.agentId !== "bash" && boardKey !== null && boardKeyOfTab(tab) === boardKey)
        .map((tab) => ({ id: tab.id, name: tab.title?.trim() || tab.agentLabel })),
    [tabs, boardKey],
  );
}

const small = `cc-t h-6 px-2 rounded-md text-[11px] font-medium text-gray-600 dark:text-gray-300
  hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-40`;
const field = `w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-2 py-1
  text-[12px] text-gray-800 dark:text-gray-100 outline-none focus:border-accent-500`;
const label = "text-[11px] font-medium text-gray-600 dark:text-gray-300";
const hint = "text-[10.5px] text-gray-500 dark:text-gray-400";
const errorText = "text-[10.5px] text-red-600 dark:text-red-400";

/**
 * As rotinas: uma mensagem que um agente recebe no horário (ou um lembrete para você).
 * Lista as que existem, cria novas por um formulário e as liga, desliga, roda ou apaga.
 */
export function RoutinesPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const uid = useId();
  const agents = useCanvasAgents();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** `null` = mostrando a lista; um rascunho = o formulário de nova rotina. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    invoke<Routine[]>("routine_list_all")
      .then((list) => { setRoutines(list); setLoadError(null); })
      .catch((e) => { setRoutines((current) => current ?? []); setLoadError(String(e)); });
  }, []);

  useEffect(() => {
    load();
    const off = listen("cc-routines-changed", load);
    // A "próxima vez" é relativa: atualiza de vez em quando.
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(tick);
      off.then((fn) => fn());
    };
  }, [load]);

  const fail = (e: unknown) => AlertaToast(t("canvas.routines.title"), String(e), "error", 6000);

  // ── Lista ─────────────────────────────────────────────────────────

  const toggle = (r: Routine) => invoke("routine_set_enabled", { id: r.id, enabled: !r.enabled }).catch(fail);
  const toggleCatchUp = (r: Routine) => invoke("routine_set_catch_up", { id: r.id, catchUp: !r.catchUp }).catch(fail);
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
    setConfirmId(null);
    invoke("routine_remove", { id: r.id }).catch(fail);
  };

  // ── Formulário ────────────────────────────────────────────────────

  const startFrom = (patch: Partial<Draft> = {}) => {
    setDraft({ ...emptyDraft(Date.now(), agents[0]?.id ?? null), ...patch });
    setErrors({});
    setFormError(null);
  };
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const closeForm = () => { setDraft(null); setFormError(null); };

  const submit = async () => {
    if (!draft) return;
    const { errors: found, schedule } = checkDraft(draft, Date.now());
    setErrors(found);
    if (found.name || found.text || found.schedule || !schedule) return;
    setSaving(true);
    setFormError(null);
    try {
      await invoke("routine_create_ui", {
        name: draft.name.trim(),
        text: normalizeText(draft.text),
        schedule,
        targetTab: draft.target,
        catchUp: draft.catchUp && schedule.kind !== "every",
      });
      setDraft(null);
      load();
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const examples: { label: string; build: () => Partial<Draft> }[] = [
    {
      label: t("canvas.routines.ex.tests"),
      build: () => ({
        name: t("canvas.routines.ex.testsName"),
        text: t("canvas.routines.ex.testsText"),
        kind: "daily", hour: 9, minute: 0, days: [],
        target: agents[0]?.id ?? null,
      }),
    },
    {
      label: t("canvas.routines.ex.reminder"),
      build: () => ({
        name: t("canvas.routines.ex.reminderName"),
        text: t("canvas.routines.ex.reminderText"),
        kind: "once", onceAt: toLocalInput(new Date(Date.now() + 45 * 60_000)),
        target: null,
      }),
    },
    {
      label: t("canvas.routines.ex.review"),
      build: () => ({
        name: t("canvas.routines.ex.reviewName"),
        text: t("canvas.routines.ex.reviewText"),
        kind: "every", amount: "2", unit: "h",
        target: agents[0]?.id ?? null,
      }),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────

  const dockWidth = useDockWidth((st) => st.width);
  const inForm = draft !== null;
  const locale = dateLocale();

  return (
    <div className="pointer-events-auto absolute right-3 bottom-[4.75rem] w-[26rem] max-h-[70%] flex flex-col rounded-xl
      border border-gray-200 dark:border-white/10 bg-white/98 dark:bg-surface-raised/98 shadow-lg overflow-hidden"
      style={dockWidth > 0 ? { width: dockWidth } : undefined}>
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-gray-200 dark:border-white/10">
        <span className="text-[12.5px] font-medium text-gray-800 dark:text-gray-100">
          {inForm ? t("canvas.routines.newRoutine") : t("canvas.routines.title")}
        </span>
        <span className="flex-1" />
        {!inForm && (
          <Button variant="primary" onClick={() => startFrom()} className="h-6 px-2.5 text-[11px]">
            {t("canvas.routines.newRoutine")}
          </Button>
        )}
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.routines.close")}
          className="cc-t w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>

      {!inForm && (
        <p className={`px-3 pt-2 pb-1 shrink-0 text-[11px] leading-relaxed ${hint}`}>{t("canvas.routines.subtitle")}</p>
      )}

      {draft ? (
        <div className="flex flex-col gap-3 p-3 overflow-y-auto">
          <Row id={`${uid}-name`} label={t("canvas.routines.name")} error={errors.name ? t(errors.name) : undefined}>
            <input id={`${uid}-name`} className={field} value={draft.name} placeholder={t("canvas.routines.namePlaceholder")}
              onChange={(e) => patch({ name: e.target.value })} />
            <span className={hint}>{t("canvas.routines.chars", { n: [...draft.name.trim()].length, max: MAX_NAME })}</span>
          </Row>

          <Row id={`${uid}-text`} label={t("canvas.routines.message")} hintText={t("canvas.routines.messageHint")}
            error={errors.text ? t(errors.text) : undefined}>
            <textarea id={`${uid}-text`} rows={3} className={`${field} resize-none`} value={draft.text}
              onChange={(e) => patch({ text: e.target.value })} />
            <span className={`${hint} text-right`}>{t("canvas.routines.chars", { n: normalizeText(draft.text).length, max: MAX_TEXT })}</span>
          </Row>

          <div className="flex flex-col gap-1.5">
            <span className={label}>{t("canvas.routines.when")}</span>
            <div role="group" aria-label={t("canvas.routines.when")} className="flex rounded-md bg-gray-100 dark:bg-white/6 p-0.5">
              {(["every", "daily", "once"] as const).map((kind) => (
                <button key={kind} type="button" aria-pressed={draft.kind === kind} onClick={() => patch({ kind })}
                  className={`flex-1 h-6 rounded text-[11px] font-medium cc-t ${draft.kind === kind
                    ? "bg-white dark:bg-white/15 text-gray-800 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400"}`}>
                  {kind === "every" ? t("canvas.routines.whenEvery") : kind === "daily" ? t("canvas.routines.whenDaily") : t("canvas.routines.whenOnce")}
                </button>
              ))}
            </div>

            {draft.kind === "every" && (
              <div className="flex gap-2">
                <input type="number" min={1} aria-label={t("canvas.routines.amount")} className={`${field} w-24`} value={draft.amount}
                  onChange={(e) => patch({ amount: e.target.value })} />
                <select aria-label={t("canvas.routines.unit")} className={`${field} w-32`} value={draft.unit}
                  onChange={(e) => patch({ unit: e.target.value as "min" | "h" })}>
                  <option value="min">{t("canvas.routines.unitMin")}</option>
                  <option value="h">{t("canvas.routines.unitHour")}</option>
                </select>
              </div>
            )}

            {draft.kind === "daily" && (
              <>
                <input type="time" aria-label={t("canvas.routines.whenDaily")} className={`${field} w-32`}
                  value={`${pad(draft.hour)}:${pad(draft.minute)}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    if (Number.isInteger(h) && Number.isInteger(m)) patch({ hour: h, minute: m });
                  }} />
                <span className={label}>{t("canvas.routines.days")}</span>
                <div className="flex gap-1">
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => {
                    const on = draft.days.includes(d);
                    return (
                      <button key={d} type="button" aria-pressed={on}
                        onClick={() => patch({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })}
                        className={`flex-1 h-6 rounded-md text-[11px] cc-t ${on
                          ? "bg-accent-500/15 text-accent-600 dark:text-accent-300 font-medium"
                          : "bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400"}`}>
                        {t(`canvas.routines.sched.day${d}`)}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {draft.kind === "once" && (
              <input type="datetime-local" aria-label={t("canvas.routines.onceAt")} className={`${field} w-auto`} value={draft.onceAt}
                onChange={(e) => patch({ onceAt: e.target.value })} />
            )}
            {errors.schedule && <span className={errorText}>{t(errors.schedule)}</span>}
          </div>

          <Row id={`${uid}-target`} label={t("canvas.routines.target")}>
            <select id={`${uid}-target`} className={field} value={draft.target ?? ""}
              onChange={(e) => patch({ target: e.target.value || null })}>
              <option value="">{t("canvas.routines.targetReminder")}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {agents.length === 0 && <span className={hint}>{t("canvas.routines.noAgents")}</span>}
          </Row>

          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" className="mt-0.5 size-3.5 accent-accent-500" disabled={draft.kind === "every"}
              checked={draft.catchUp && draft.kind !== "every"} onChange={(e) => patch({ catchUp: e.target.checked })} />
            <span className="flex flex-col">
              <span className={label}>{t("canvas.routines.catchUp")}</span>
              <span className={hint}>{draft.kind === "every" ? t("canvas.routines.catchUpNever") : t("canvas.routines.catchUpHelp")}</span>
            </span>
          </label>

          <p role="status" aria-live="polite" className="rounded-md bg-gray-50 dark:bg-white/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-gray-700 dark:text-gray-200">
            {summarize(draft, draft.target ? agents.find((a) => a.id === draft.target)?.name ?? null : null, t, Date.now())
              ?? t("canvas.routines.sum.empty")}
          </p>

          {formError && <p role="alert" className={errorText}>{formError}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeForm} disabled={saving}>{t("canvas.routines.cancel")}</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={saving}>{t("canvas.routines.create")}</Button>
          </div>
        </div>
      ) : (
        <div className="overflow-y-auto">
          {loadError && <p role="alert" className="px-3 py-2 text-[12px] text-red-600 dark:text-red-400">{loadError}</p>}
          {routines === null ? null : routines.length === 0 && !loadError ? (
            <div className="flex flex-col gap-2 px-3 py-3">
              <p className="text-[12.5px] font-medium text-gray-800 dark:text-gray-100">{t("canvas.routines.emptyTitle")}</p>
              <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-gray-400">{t("canvas.routines.emptyText")}</p>
              {examples.map((ex) => (
                <button key={ex.label} type="button" onClick={() => startFrom(ex.build())}
                  className="cc-t text-left rounded-md border border-gray-200 dark:border-white/10 px-2.5 py-1.5 text-[12px]
                    text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6">
                  {ex.label}
                </button>
              ))}
            </div>
          ) : (
            routines.map((r) => {
              const next = r.enabled && r.nextRun
                ? `${t("canvas.routines.nextRun")} ${relativeFrom(r.nextRun, now, locale) ?? t("canvas.routines.soon")} (${when(r.nextRun)})`
                : "";
              return (
                <div key={r.id} className="px-3 py-2 border-b last:border-b-0 border-gray-100 dark:border-white/6">
                  <div className="flex items-center gap-2">
                    <span title={r.name} className={`truncate text-[12.5px] font-medium ${r.enabled ? "text-gray-800 dark:text-gray-100" : "text-gray-400 dark:text-gray-500"}`}>
                      {r.name}
                    </span>
                    <span className="flex-1" />
                    <button type="button" role="switch" aria-checked={r.enabled} onClick={() => toggle(r)}
                      className="cc-t flex items-center gap-1.5 h-6 px-1 rounded-md text-[11px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/8">
                      <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors ${r.enabled ? "bg-accent-500" : "bg-gray-300 dark:bg-white/20"}`}>
                        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${r.enabled ? "translate-x-3" : "translate-x-0.5"}`} />
                      </span>
                      {r.enabled ? t("canvas.routines.on") : t("canvas.routines.off")}
                    </button>
                  </div>

                  <div className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                    {describeSchedule(r.schedule, t)}
                    <span className="text-gray-400"> · </span>
                    {r.targetTab ? t("canvas.routines.sendTo", { name: r.targetName }) : t("canvas.routines.destReminder")}
                  </div>
                  {next && <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{next}</div>}
                  <div className="mt-0.5 truncate text-[11px] text-gray-400 dark:text-gray-500" title={r.text}>“{r.text}”</div>
                  {r.missedAt ? (
                    <div className="mt-0.5 text-[10.5px] text-amber-600 dark:text-amber-400">
                      {t("canvas.routines.waiting")} {when(r.missedAt)}
                    </div>
                  ) : null}
                  {r.lastRun ? (
                    <div className="mt-0.5 text-[10.5px] text-gray-400 dark:text-gray-500">
                      {t("canvas.routines.last")} {when(r.lastRun)} · {r.lastResult}
                    </div>
                  ) : r.lastResult ? (
                    <div className="mt-0.5 text-[10.5px] text-amber-600 dark:text-amber-400">{r.lastResult}</div>
                  ) : null}

                  <div className="mt-1.5 flex items-center gap-1">
                    <Button variant="custom" onClick={() => toggleCatchUp(r)} aria-pressed={r.catchUp}
                      disabled={r.schedule.kind === "every"}
                      title={r.schedule.kind === "every" ? t("canvas.routines.catchUpNever") : r.catchUp ? t("canvas.routines.catchUpOn") : t("canvas.routines.catchUpOff")}
                      className={`${small} ${r.catchUp ? "bg-accent-500/15 text-accent-600 dark:text-accent-300" : ""}`}>
                      {t("canvas.routines.catchUp")}
                    </Button>
                    <span className="flex-1" />
                    <Button variant="custom" className={small} disabled={running === r.id} onClick={() => runNow(r)}
                      title={t("canvas.routines.runHint")}>
                      {running === r.id ? "…" : t("canvas.routines.runNow")}
                    </Button>
                    <Button variant="custom" onClick={() => setConfirmId(confirmId === r.id ? null : r.id)}
                      className="cc-t h-6 px-2 rounded-md text-[11px] font-medium text-gray-400 hover:text-red-500">
                      {t("canvas.routines.remove")}
                    </Button>
                  </div>

                  {confirmId === r.id && (
                    <div role="alertdialog" aria-label={t("canvas.routines.removeAsk", { name: r.name })}
                      className="mt-1.5 flex items-center gap-2 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-2 py-1.5">
                      <span className="flex-1 text-[11px] text-gray-700 dark:text-gray-200">{t("canvas.routines.removeAsk", { name: r.name })}</span>
                      <Button variant="custom" className={small} onClick={() => setConfirmId(null)}>{t("canvas.routines.cancel")}</Button>
                      <Button variant="custom" className="cc-t h-6 px-2 rounded-md text-[11px] font-medium text-white bg-red-500 hover:bg-red-600"
                        onClick={() => remove(r)}>
                        {t("canvas.routines.removeYes")}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Um campo do formulário: rótulo, o controle, uma dica ou erro embaixo. */
function Row({ id, label: text, hintText, error, children }: { id: string; label: string; hintText?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={label}>{text}</label>
      {children}
      {hintText && <span className={hint}>{hintText}</span>}
      {error && <span className={errorText}>{error}</span>}
    </div>
  );
}
