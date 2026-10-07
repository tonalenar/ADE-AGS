import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { bytesOrNull, getMissionContextMetrics, summarize, tokensOrNull, type ContextRow, type RunContextMetric } from "./contextMetricsView";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; runs: RunContextMetric[] };

/**
 * Contexto de memória por Run e por missão: bytes e tokens estimados antes/depois da leitura por
 * índice. Sem medição mostra "sem dados" (nunca zero). Tudo entra como texto (escapado pelo React).
 */
export function MemoryContextMetricsCard({ missionId, compact = false }: { missionId: string; compact?: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    getMissionContextMetrics(missionId)
      .then((d) => alive && setState({ status: "ready", runs: Array.isArray(d?.runs) ? d.runs : [] }))
      .catch(() => alive && setState({ status: "error" }));
    return () => {
      alive = false;
    };
  }, [missionId]);

  const summary = useMemo(() => (state.status === "ready" ? summarize(state.runs) : null), [state]);
  const noData = t("memoryContext.noData");
  const shell = compact ? "ags-hq__detail" : "rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/[0.03]";
  const dim = compact ? "ags-hq__dim" : "text-gray-500 dark:text-gray-400";
  const strong = compact ? "text-gray-100" : "text-gray-800 dark:text-gray-100";
  const mut = compact ? "text-[10px] text-gray-400" : "text-[10.5px] text-gray-500 dark:text-gray-400";
  const line = compact ? "border-t border-white/10" : "border-t border-gray-200 dark:border-white/10";
  const cell = (v: string | null) => <span className={v === null ? dim : strong}>{v ?? noData}</span>;
  const pair = (a: string | null, b: string | null) =>
    a === null && b === null ? cell(null) : <>{cell(a)} → {cell(b)}</>;

  return (
    <section className={shell} aria-label={t("memoryContext.title")} aria-busy={state.status === "loading"}>
      <h3 className={`mb-2 text-[11px] font-semibold ${strong}`}>{t("memoryContext.title")}</h3>
      {state.status === "loading" && <p className={mut} role="status">{t("memoryContext.loading")}</p>}
      {state.status === "error" && <p className={mut} role="status">{t("memoryContext.error")} · {noData}</p>}
      {summary && summary.rows.length === 0 && <p className={mut}>{noData}. {t("memoryContext.noRuns")}</p>}
      {summary && summary.rows.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className={`font-semibold ${strong}`}>{t("memoryContext.mission")}</span>
            {summary.total ? (
              <span className="rounded-full border border-emerald-500/50 px-2 text-[10.5px] text-emerald-600 dark:text-emerald-400">
                {t("memoryContext.reduction", { pct: summary.total.reduction })}
              </span>
            ) : (
              <span className={dim}>{noData}</span>
            )}
          </div>
          <table className="w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className={dim}>
                <th scope="col" className="py-1 pr-2 font-normal">{t("memoryContext.col.run")}</th>
                <th scope="col" className="py-1 pr-2 font-normal">{t("memoryContext.col.bytes")}</th>
                <th scope="col" className="py-1 pr-2 font-normal">{t("memoryContext.col.tokens")}</th>
                <th scope="col" className="py-1 font-normal">{t("memoryContext.col.entries")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.total && (
                <tr className={`${line} font-semibold`}>
                  <th scope="row" className={`py-1 pr-2 font-semibold ${strong}`}>{t("memoryContext.total", { n: summary.total.runs })}</th>
                  <td className="py-1 pr-2 tabular-nums">{pair(bytesOrNull(summary.total.beforeBytes), bytesOrNull(summary.total.afterBytes))}</td>
                  <td className="py-1 pr-2 tabular-nums">{pair(tokensOrNull(summary.total.tokensBefore), tokensOrNull(summary.total.tokensAfter))}</td>
                  <td />
                </tr>
              )}
              {summary.rows.map((r: ContextRow) => (
                <tr key={r.runId} className={line}>
                  <th scope="row" className={`py-1 pr-2 font-normal ${strong}`}>
                    {t("memoryContext.run", { id: r.shortId })}
                    {r.legacy && <span className={`ml-1 ${dim}`}>({t("memoryContext.legacy")})</span>}
                  </th>
                  <td className="py-1 pr-2 tabular-nums">{pair(bytesOrNull(r.beforeBytes), bytesOrNull(r.afterBytes))}</td>
                  <td className="py-1 pr-2 tabular-nums">{pair(tokensOrNull(r.tokensBefore), tokensOrNull(r.tokensAfter))}</td>
                  <td className="py-1 tabular-nums">{r.entriesUsed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={`mt-2 ${mut}`}>{t("memoryContext.note")}</p>
        </>
      )}
    </section>
  );
}
