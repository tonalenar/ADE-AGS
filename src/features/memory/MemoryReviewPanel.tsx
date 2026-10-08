import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import * as memoryIpc from "./ipc";
import { ReviewMarks } from "./ReviewMarks";
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
    <section className="flex flex-col gap-2 rounded-xl bg-gray-100/70 p-3 dark:bg-surface-raised/60" data-testid="memory-review">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100">{t("memoryReview.title", { count: counts.total })}</h3>
        <span className="font-mono text-[10.5px] tabular-nums text-gray-500 dark:text-white/40">
          {t("memoryReview.counts", { highValue: counts.highValue, duplicates: counts.duplicates, contradictions: counts.contradictions })}
        </span>
        <span className="ml-auto flex gap-1.5">
          <button type="button" disabled={busy} onClick={() => run(items, true)}
            className="h-7 rounded-md bg-emerald-600 px-2.5 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            {t("memoryReview.approveAll")}
          </button>
          <button type="button" disabled={busy} onClick={() => run(items, false)}
            className="h-7 rounded-md bg-gray-200/80 px-2.5 text-[12px] font-medium text-gray-800 hover:bg-gray-300/70 disabled:opacity-50 dark:bg-surface-overlay dark:text-gray-100 dark:hover:bg-white/[0.14]">
            {t("memoryReview.rejectAll")}
          </button>
        </span>
      </header>
      <p className="text-[10.5px] leading-[14px] text-gray-500 dark:text-white/40">{t("memoryReview.note")}</p>
      {message && <p className="text-[11px] text-red-600 dark:text-red-400">{message}</p>}
      <ul className="flex flex-col divide-y divide-gray-200 dark:divide-white/[0.08]">
        {items.map((item) => {
          const flag = reviewFlag(item);
          const ev = evidenceParts(item);
          return (
            <li key={`${item.entryId}:${item.revision}`} className="flex flex-col gap-1.5 py-2.5" data-flag={flag}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-gray-900 dark:text-gray-100" title={item.key}>{item.key}</span>
                {flag === "highValue" && (
                  <span className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10.5px] font-semibold ${FLAG_STYLE[flag]}`}>{t(`memoryReview.flag.${flag}`)}</span>
                )}
                <button type="button" disabled={busy} onClick={() => run([item], true)}
                  className="h-6 rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{t("memoryReview.approve")}</button>
                <button type="button" disabled={busy} onClick={() => run([item], false)}
                  className="h-6 rounded-md bg-gray-200/80 px-2.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300/70 disabled:opacity-50 dark:bg-surface-overlay dark:text-gray-100 dark:hover:bg-white/[0.14]">{t("memoryReview.reject")}</button>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-4 text-gray-600 dark:text-gray-300">{item.body}</p>
              <p className="font-mono text-[10.5px] leading-[14px] text-gray-500 dark:text-white/40">
                {t("memoryReview.evidence")}: {t(`memoryReview.actor.${item.evidence.actorKind}`)}
                {ev.runId ? ` · run ${ev.runId.slice(0, 8)}` : ""}
                {ev.taskId ? ` · task ${ev.taskId.slice(0, 8)}` : ""}
                {ev.factId ? ` · fact ${ev.factId.slice(0, 8)}` : ""}
                {ev.reason ? ` · ${ev.reason}` : ""}
                {!ev.runId && !ev.taskId && !ev.factId && !ev.reason ? ` · ${t("memoryReview.noEvidence")}` : ""}
              </p>
              <ReviewMarks item={item} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
