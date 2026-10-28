import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { AlertaToast } from "@/shared/ui/alerts";

import { AppDialog } from "@/shared/ui/AppDialog";

import { agentReads, applyCleanup, fetchCandidates, fetchScorecard, fetchUsage, percent, scorecardReliable, type Scorecard, suggestedIds, usageVerdict, type CleanupCandidate, type UsageReport } from "./memoryUsage";

/**
 * "Uso da memória": se os agentes estão lendo o que foi aprovado. Mostra buscas, aberturas, cobertura (quanto
 * do que existe já foi lido) e por missão. Daqui sai a limpeza: duplicadas, chaves de teste e o que o Jev
 * rejeitaria, sempre com a sua confirmação.
 */
export function MemoryUsageCard({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [score, setScore] = useState<Scorecard | null>(null);

  const load = useCallback(() => {
    fetchUsage(workspaceId).then((r) => { setReport(r); setFailed(false); }).catch(() => setFailed(true));
    fetchScorecard().then(setScore).catch(() => setScore(null));
  }, [workspaceId]);
  useEffect(load, [load]);

  const verdict = usageVerdict(report);
  const read = report ? report.activeEntries - report.neverRead : 0;
  const coverage = report ? percent(read, report.activeEntries) : null;
  const hitRate = report ? percent(report.searchesWithHits, report.searches) : null;
  const tone = verdict === "active" ? "text-emerald-600 dark:text-emerald-400" : verdict === "unknown" ? "text-gray-500" : "text-amber-600 dark:text-amber-400";

  return (
    <section aria-label={t("memoryUsage.title")} className="rounded-xl bg-gray-100/70 p-3 dark:bg-surface-raised/60 text-[11.5px] text-gray-700 dark:text-gray-200">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold text-gray-900 dark:text-gray-100">{t("memoryUsage.title")}</h3>
        <Button variant="custom" className="cc-t h-6 px-2 rounded-md text-[11px] bg-gray-200/80 dark:bg-white/8 hover:brightness-110" onClick={() => setCleaning(true)}>
          {t("memoryUsage.clean")}
        </Button>
      </div>
      {failed && <p className="text-gray-500">{t("memoryUsage.error")}</p>}
      {!failed && !report && <p className="text-gray-500" role="status">{t("memoryUsage.loading")}</p>}
      {report && (
        <>
          <p className={`mb-2 font-medium ${tone}`}>{t(`memoryUsage.verdict.${verdict}`)}</p>
          {verdict !== "unknown" && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono tabular-nums">
              <dt className="font-sans text-gray-500">{t("memoryUsage.injected")}</dt><dd>{report.injected}</dd>
              <dt className="font-sans text-gray-500">{t("memoryUsage.searches")}</dt>
              <dd>{report.searches}{hitRate !== null && <span className="text-gray-500"> ({t("memoryUsage.withHits", { pct: hitRate })})</span>}</dd>
              <dt className="font-sans text-gray-500">{t("memoryUsage.opens")}</dt><dd>{report.opens}</dd>
              <dt className="font-sans text-gray-500">{t("memoryUsage.agents")}</dt><dd>{report.distinctAgents}</dd>
              <dt className="font-sans text-gray-500">{t("memoryUsage.coverage")}</dt>
              <dd>{coverage === null ? "—" : `${coverage}%`}<span className="text-gray-500"> ({read}/{report.activeEntries})</span></dd>
            </dl>
          )}
          {report.topRead.length > 0 && (
            <div className="mt-2">
              <p className="text-gray-500">{t("memoryUsage.top")}</p>
              <ul className="font-mono text-[11px]">
                {report.topRead.slice(0, 5).map((r) => (
                  <li key={r.key} className="flex justify-between gap-2"><span className="truncate" title={r.key}>{r.key}</span><span>{r.count}×</span></li>
                ))}
              </ul>
            </div>
          )}
          {report.missions.length > 0 && (
            <table className="mt-2 w-full text-left text-[11px]">
              <thead>
                <tr className="text-gray-500">
                  <th className="font-normal">{t("memoryUsage.mission")}</th>
                  <th className="font-normal">{t("memoryUsage.col.injected")}</th>
                  <th className="font-normal">{t("memoryUsage.col.reads")}</th>
                </tr>
              </thead>
              <tbody>
                {report.missions.slice(0, 8).map((m) => (
                  <tr key={m.missionId} className="border-t border-gray-200 dark:border-white/8">
                    <td className="truncate max-w-40 py-0.5" title={m.title}>{m.title}</td>
                    <td className="font-mono">{m.injected}</td>
                    <td className="font-mono">{m.searches + m.opens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {verdict !== "unknown" && <p className="mt-2 text-[10.5px] text-gray-500">{t("memoryUsage.note", { reads: agentReads(report) })}</p>}
        </>
      )}
      {score && score.labeled > 0 && (
        <div className="mt-3 border-t border-gray-200 dark:border-white/8 pt-2">
          <p className="font-medium text-gray-900 dark:text-gray-100">{t("memoryUsage.score.title")}</p>
          <p className="text-gray-500">{t("memoryUsage.score.body", { labeled: score.labeled, answered: score.answered, rejected: score.jevReject })}</p>
          {score.rejectRecall !== null && <p className="font-mono">{t("memoryUsage.score.recall", { pct: Math.round(score.rejectRecall * 100) })}</p>}
          {score.falseAlarmRate !== null && <p className="font-mono">{t("memoryUsage.score.falseAlarm", { pct: Math.round(score.falseAlarmRate * 100), n: score.approvedByHuman })}</p>}
          {!scorecardReliable(score) && <p className="text-[10.5px] text-amber-600 dark:text-amber-400">{t("memoryUsage.score.few")}</p>}
        </div>
      )}
      {cleaning && <CleanupDialog workspaceId={workspaceId} onClose={() => setCleaning(false)} onDone={load} />}
    </section>
  );
}

function CleanupDialog({ workspaceId, onClose, onDone }: { workspaceId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<CleanupCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCandidates(workspaceId).then(setList).catch((e) => { setList([]); setError(String(e)); });
  }, [workspaceId]);

  const toggle = (id: string) => {
    setArmed(false);
    setPicked((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const apply = async () => {
    if (picked.size === 0 || busy) return;
    if (!armed) { setArmed(true); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await applyCleanup(workspaceId, [...picked]);
      AlertaToast(t("memoryUsage.cleanup.title"), t("memoryUsage.cleanup.done", { count: result.deleted, failed: result.failed.length }), result.failed.length ? "warning" : "info", 6000);
      onDone();
      const failedIds = new Set(result.failed.map((f) => f.entryId));
      setList((cur) => (cur ?? []).filter((c) => !picked.has(c.entryId) || failedIds.has(c.entryId)));
      setPicked(new Set());
      setArmed(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog title={t("memoryUsage.cleanup.title")} size="lg" closeOnEsc onClose={() => !busy && onClose()}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.close")}</Button>
          <Button variant={armed ? "danger" : "primary"} disabled={picked.size === 0 || busy} onClick={() => void apply()}>
            {armed ? t("memoryUsage.cleanup.confirm", { count: picked.size }) : t("memoryUsage.cleanup.delete", { count: picked.size })}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-2 text-[12.5px] text-gray-700 dark:text-gray-200">
        {list === null && <p className="text-gray-400">{t("memoryUsage.loading")}</p>}
        {list && list.length === 0 && <p>{t("memoryUsage.cleanup.empty")}</p>}
        {list && list.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">{t("memoryUsage.cleanup.found", { count: list.length })}</span>
              <span className="flex gap-3">
                <Button variant="custom" className="text-[11.5px] text-accent-600" onClick={() => { setArmed(false); setPicked(new Set(suggestedIds(list))); }}>{t("memoryUsage.cleanup.suggested")}</Button>
                <Button variant="custom" className="text-[11.5px] text-gray-500" onClick={() => { setArmed(false); setPicked(new Set()); }}>{t("memoryUsage.cleanup.none")}</Button>
              </span>
            </div>
            <ul className="max-h-80 overflow-auto cc-scroll divide-y divide-gray-100 dark:divide-white/6 rounded-md border border-gray-200 dark:border-white/10">
              {list.map((c) => (
                <li key={c.entryId} className="flex gap-2 px-2 py-1.5">
                  <input type="checkbox" className="mt-1 size-3.5 accent-accent-500" checked={picked.has(c.entryId)} onChange={() => toggle(c.entryId)} aria-label={c.key} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="truncate font-semibold" title={c.key}>{c.key}</code>
                      <span className="text-[10.5px] text-gray-400">{c.scope === "mission" ? t("memoryUsage.cleanup.scopeMission") : t("memoryUsage.cleanup.scopeWorkspace")}</span>
                    </div>
                    <p className="truncate text-gray-500" title={c.bodyPreview}>{c.bodyPreview}</p>
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">{c.reasons.join(" · ")}</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <p role="alert" className="text-red-500 whitespace-pre-wrap">{error}</p>}
      </div>
    </AppDialog>
  );
}
