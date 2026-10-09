import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BulkOutcome } from "./bulkReview";
import { approveDream, diffLines, reviewableDreams } from "./dreamReview";
import { AlertaToast } from "neogestify-ui-components";
import * as memoryIpc from "./ipc";
import type { MemoryDream } from "./types";
import { dateLocale } from "@/i18n/dateLocale";

const DIFF_STYLE = { add: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", del: "bg-red-500/15 text-red-700 dark:text-red-300", ctx: "text-gray-500 dark:text-white/45" } as const;

/** Botão "Sonhar agora" + grupos "Sonho de <data>" com as propostas e o diff Markdown calculado pelo ADE. */
export function DreamSection({ workspaceId, onChanged }: { workspaceId: string; onChanged: (o?: BulkOutcome) => void }) {
  const { t } = useTranslation();
  const [dreams, setDreams] = useState<MemoryDream[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(() => memoryIpc.listDreams(workspaceId).then(setDreams).catch(() => setDreams([])), [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const start = async () => {
    setBusy(true); setMessage("");
    try { await memoryIpc.startDream(workspaceId); setMessage(t("memoryDream.started")); await load(); }
    catch (cause) { setMessage(String(cause)); }
    finally { setBusy(false); }
  };
  const approve = async (d: MemoryDream) => {
    setBusy(true);
    try { const o = await approveDream(d, memoryIpc.decideMemory); await load(); onChanged(o); }
    finally { setBusy(false); }
  };
  const reject = async (d: MemoryDream) => {
    setBusy(true);
    // Rejeitar sem avisar nada escondia falhas: conta as que não foram e diz quantas.
    let failed = 0;
    try {
      for (const p of d.proposals) await memoryIpc.decideMemory(p.entryId, p.revision, false).catch(() => { failed += 1; });
      await load();
      onChanged();
      if (failed > 0) AlertaToast(t("memoryInbox.syncRetry"), t("memoryDream.rejectFailed", { count: failed }), "warning", 8000);
    }
    finally { setBusy(false); }
  };

  const ready = reviewableDreams(dreams);
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => void start()} className="h-7 rounded-md bg-violet-500/12 px-3 text-[12px] font-medium text-violet-700 hover:bg-violet-500/20 disabled:opacity-50 dark:text-violet-300">{t("memoryDream.start")}</button>
        {dreams.some((d) => d.status === "running") && <span role="status" className="text-[10.5px] text-gray-500 dark:text-white/45">{t("memoryDream.running")}</span>}
        {message && <span role="status" className="text-[10.5px] text-gray-500 dark:text-white/45">{message}</span>}
      </div>
      {ready.map((d) => {
        const title = t("memoryDream.group", { date: new Date(d.createdAt).toLocaleDateString(dateLocale()) });
        return (
          <section key={d.dreamId} aria-label={title} className="mt-2 rounded-xl bg-gray-100/70 p-3 dark:bg-surface-raised/60">
            <h3 className="flex items-center gap-2 text-[12px] font-semibold text-gray-900 dark:text-gray-100">
              {title}
              <span className="font-mono text-[10.5px] font-normal tabular-nums text-gray-500 dark:text-white/40">{t("memoryInbox.count", { count: d.proposals.length })}</span>
              <span className="flex-1" />
              <button type="button" disabled={busy} onClick={() => void approve(d)} aria-label={`${t("memoryDream.approveGroup")}: ${title}`} className="h-6 rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{t("memoryDream.approveGroup")}</button>
              <button type="button" disabled={busy} onClick={() => void reject(d)} aria-label={`${t("memoryDream.rejectGroup")}: ${title}`} className="h-6 rounded-md bg-gray-200/80 px-2.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300/70 disabled:opacity-50 dark:bg-surface-overlay dark:text-gray-100 dark:hover:bg-white/[0.14]">{t("memoryDream.rejectGroup")}</button>
            </h3>
            <ul className="mt-2 list-disc pl-4 text-[11.5px] leading-4">
              {d.proposals.map((p) => (
                <li key={`${p.entryId}:${p.revision}`} className="mb-1">
                  <span className="font-mono font-medium">{p.operation ?? "update"} · {p.key}</span>
                  <span className="block whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{p.body}</span>
                  <span className="block font-mono text-[10.5px] text-gray-500 dark:text-white/40">{p.evidence.reason ?? t("memoryReview.noEvidence")}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-white/45">{t("memoryDream.diff")}</p>
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-gray-200/50 p-2 font-mono text-[10.5px] leading-[15px] tabular-nums dark:bg-surface-sunken" role="region" tabIndex={0} aria-label={t("memoryDream.diff")}>
              {diffLines(d.markdownDiff).map((l, i) => <div key={i} className={DIFF_STYLE[l.kind]}>{l.text || " "}</div>)}
            </pre>
            {d.questions.length > 0 && (
              <div className="mt-2 text-[11px]">
                <p className="font-semibold">{t("memoryDream.questions")}</p>
                <ul className="list-disc pl-4">{d.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
