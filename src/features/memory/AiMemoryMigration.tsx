import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { splitMigrationReport } from "./aiMemory";
import type { AiMemoryMigrationRow, AiMemoryMigrationSummary } from "./aiMemory";
import { aiMemoryMigrate, aiMemoryMigrationReport } from "./aiMemoryIpc";

/**
 * Cópia única da memória antiga do ADE (SQLite, só leitura) para o wiki do ai-memory. Nada é
 * apagado nem sobrescrito: rodar de novo só copia o que faltou. Mostra o que foi copiado e o que
 * ficou de fora, com o motivo.
 */
export function AiMemoryMigration({ workspaceId, cwd }: { workspaceId: string; cwd: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AiMemoryMigrationRow[] | null>(null);
  const [summary, setSummary] = useState<AiMemoryMigrationSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(() => {
    aiMemoryMigrationReport(workspaceId).then(setRows).catch((e) => setError(String(e)));
  }, [workspaceId]);

  useEffect(() => { setRows(null); setSummary(null); loadReport(); }, [loadReport]);

  const run = () => {
    setRunning(true);
    setError(null);
    aiMemoryMigrate(workspaceId, cwd)
      .then((s) => { setSummary(s); loadReport(); })
      .catch((e) => setError(String(e)))
      .finally(() => setRunning(false));
  };

  const report = rows ? splitMigrationReport(rows) : null;
  const label = (r: AiMemoryMigrationRow) => r.key || r.entry_id;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="font-semibold">{t("aiMemory.migration.title")}</h4>
        <Button variant="custom" disabled={running} onClick={run}
          className="cc-t h-6 rounded-md bg-gray-200/80 px-2 text-[11px] hover:brightness-110 disabled:opacity-50 dark:bg-white/8">
          {running ? t("aiMemory.migration.running") : rows && rows.length > 0 ? t("aiMemory.migration.again") : t("aiMemory.migration.run")}
        </Button>
      </div>
      <p className="mb-1 text-gray-500">{t("aiMemory.migration.hint")}</p>
      {error && <p className="text-red-500" role="alert">{t("aiMemory.error", { error })}</p>}
      {summary && (
        <p role="status" className="mb-1">
          {t("aiMemory.migration.summary", { written: summary.written, already: summary.already, left: summary.skipped_secret + summary.conflict + summary.divergent + summary.failed })}
          {summary.reason && <span className="block text-gray-500">{summary.reason}</span>}
          {summary.stopped && <span className="block text-amber-600 dark:text-amber-400">{t("aiMemory.migration.stopped", { reason: summary.stopped })}</span>}
        </p>
      )}
      {report && rows && rows.length === 0 && !summary && <p className="text-gray-500">{t("aiMemory.migration.never")}</p>}
      {report && report.copied.length > 0 && (
        <details>
          <summary className="cursor-pointer">{t("aiMemory.migration.copied", { count: report.copied.length })}</summary>
          <ul className="ml-3">
            {report.copied.map((r) => <li key={`${r.entry_id}:${r.revision}`}>{label(r)}{r.wiki_path && <span className="text-gray-500"> → {r.wiki_path}</span>}</li>)}
          </ul>
        </details>
      )}
      {report?.left.map((group) => (
        <details key={group.status}>
          <summary className="cursor-pointer">{t(`aiMemory.migration.left.${group.status}`, { count: group.rows.length })}</summary>
          <ul className="ml-3">
            {group.rows.map((r) => <li key={`${r.entry_id}:${r.revision}`}>{label(r)}{r.reason && <span className="text-gray-500"> · {r.reason}</span>}</li>)}
          </ul>
        </details>
      ))}
    </div>
  );
}
