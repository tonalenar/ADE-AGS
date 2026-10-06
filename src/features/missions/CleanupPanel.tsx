import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { canConfirmCleanup, cleanupBlockers, formatBytes, missionCleanup, totalBytes, type CleanupReport } from "./cleanup";

/** La simulación y el resultado de la limpieza, por props. */
export function CleanupReportView({ report, busy, onConfirm }: { report: CleanupReport; busy: boolean; onConfirm: () => void }) {
  const { t } = useTranslation();
  const blockers = cleanupBlockers(report);
  if (report.entries.length === 0) return <p className="text-[11px] text-gray-500 dark:text-white/45">{t("missions.cleanup.nothing")}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="cleanup-report">
      <ul className="flex flex-col gap-1">
        {report.entries.map((e) => (
          <li key={e.root} className="flex items-center gap-2 text-[11px]">
            <span className="truncate font-mono text-gray-700 dark:text-gray-200" title={e.root}>{e.branch}</span>
            <span className="shrink-0 tabular-nums text-gray-500 dark:text-white/45">{formatBytes(e.sizeBytes)}</span>
            {e.removed && <span className="shrink-0 text-emerald-600 dark:text-emerald-400">{t("missions.cleanup.removed")}</span>}
          </li>
        ))}
      </ul>
      {blockers.length > 0 && (
        <div className="rounded border border-amber-300/50 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-300" data-testid="cleanup-blockers">
          <p className="font-semibold">{t("missions.cleanup.blocked")}</p>
          <ul className="list-disc pl-4">{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </div>
      )}
      {report.dryRun && (
        <div className="flex items-center gap-2">
          <Button variant="danger" size="sm" disabled={busy || !canConfirmCleanup(report)} onClick={onConfirm}>
            {t("missions.cleanup.confirm", { size: formatBytes(totalBytes(report)) })}
          </Button>
          <span className="text-[10.5px] text-gray-500 dark:text-white/45">{t("missions.cleanup.safe")}</span>
        </div>
      )}
    </div>
  );
}

/** «Limpar worktrees»: primero simula (dry-run) y solo después de verlo se confirma. */
export function CleanupPanel({ missionId }: { missionId: string }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError("");
    try { setReport(await missionCleanup(missionId, dryRun)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" size="sm" className="self-start" disabled={busy} onClick={() => run(true)}>{t("missions.cleanup.check")}</Button>
      {error && <p className="text-[11px] text-red-500 dark:text-red-400">{error}</p>}
      {report && <CleanupReportView report={report} busy={busy} onConfirm={() => run(false)} />}
    </div>
  );
}
