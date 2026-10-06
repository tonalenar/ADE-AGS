import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import * as memoryIpc from "./ipc";
import { usePendingMemoryStore } from "./pendingStore";
import { decideAll, evidenceParts, reviewFlag, sortReviewItems, type ReviewFlag } from "./review";
import type { MemoryReviewItem, MemoryReviewSummary } from "./types";

const FLAG_STYLE: Record<ReviewFlag, string> = {
  contradiction: "bg-red-500/15 text-red-600 dark:text-red-400",
  duplicate: "bg-gray-500/15 text-gray-500 dark:text-gray-400",
  highValue: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  normal: "",
};

/**
 * Resumo das memórias sugeridas pelos agentes na missão, com aprovar/rejeitar todas ou uma a uma.
 * A decisão é sempre um clique do usuário: nada é aprovado automaticamente.
 */
export function MemoryReviewPanel({ missionId, workspaceId, refreshKey = "" }: { missionId: string; workspaceId: string; refreshKey?: string }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<MemoryReviewSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const loadPending = usePendingMemoryStore((s) => s.load);

  const load = useCallback(
    () => memoryIpc.getMemoryReviewSummary(missionId).then(setSummary).catch(() => setSummary(null)),
    [missionId],
  );

  useEffect(() => {
    setMessage("");
    void load();
  }, [load, refreshKey]);

  const run = async (items: MemoryReviewItem[], approve: boolean) => {
    if (busy || items.length === 0) return;
    setBusy(true);
    setMessage("");
    const result = await decideAll(items, approve, memoryIpc.decideMemory);
    if (result.failed.length > 0) setMessage(t("memoryReview.failed", { keys: result.failed.join(", ") }));
    await load();
    await loadPending(workspaceId).catch(() => undefined);
    setBusy(false);
  };

  if (!summary || summary.items.length === 0) return null;
  const items = sortReviewItems(summary.items);
  const { counts } = summary;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 dark:border-white/10" data-testid="memory-review">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] font-semibold text-gray-700 dark:text-gray-200">{t("memoryReview.title", { count: counts.total })}</h3>
        <span className="text-[11px] text-gray-400 dark:text-white/35">
          {t("memoryReview.counts", { highValue: counts.highValue, duplicates: counts.duplicates, contradictions: counts.contradictions })}
        </span>
        <span className="ml-auto flex gap-1.5">
          <button type="button" disabled={busy} onClick={() => run(items, true)}
            className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50">
            {t("memoryReview.approveAll")}
          </button>
          <button type="button" disabled={busy} onClick={() => run(items, false)}
            className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 disabled:opacity-50 dark:border-white/20 dark:text-gray-300">
            {t("memoryReview.rejectAll")}
          </button>
        </span>
      </header>
      <p className="text-[10.5px] text-gray-400 dark:text-white/35">{t("memoryReview.note")}</p>
      {message && <p className="text-[11px] text-red-600 dark:text-red-400">{message}</p>}
      <ul className="flex flex-col divide-y divide-gray-100 dark:divide-white/5">
        {items.map((item) => {
          const flag = reviewFlag(item);
          const ev = evidenceParts(item);
          const related = item.contradicts ?? item.duplicateOf;
          return (
            <li key={`${item.entryId}:${item.revision}`} className="flex flex-col gap-1 py-2" data-flag={flag}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gray-700 dark:text-gray-200" title={item.key}>{item.key}</span>
                {flag !== "normal" && (
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${FLAG_STYLE[flag]}`}>{t(`memoryReview.flag.${flag}`)}</span>
                )}
                <button type="button" disabled={busy} onClick={() => run([item], true)}
                  className="rounded bg-emerald-600/90 px-2 py-0.5 text-[11px] text-white disabled:opacity-50">{t("memoryReview.approve")}</button>
                <button type="button" disabled={busy} onClick={() => run([item], false)}
                  className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 disabled:opacity-50 dark:border-white/20 dark:text-gray-300">{t("memoryReview.reject")}</button>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap text-[11.5px] text-gray-600 dark:text-gray-300">{item.body}</p>
              <p className="text-[10.5px] text-gray-400 dark:text-white/35">
                {t("memoryReview.evidence")}: {t(`memoryReview.actor.${item.evidence.actorKind}`)}
                {ev.runId ? ` · run ${ev.runId.slice(0, 8)}` : ""}
                {ev.taskId ? ` · task ${ev.taskId.slice(0, 8)}` : ""}
                {ev.factId ? ` · fact ${ev.factId.slice(0, 8)}` : ""}
                {ev.reason ? ` · ${ev.reason}` : ""}
                {!ev.runId && !ev.taskId && !ev.factId && !ev.reason ? ` · ${t("memoryReview.noEvidence")}` : ""}
              </p>
              {related && (
                <p className="text-[10.5px] text-amber-600 dark:text-amber-400">
                  {t(flag === "contradiction" ? "memoryReview.contradicts" : "memoryReview.duplicateOf", { key: related.key })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
