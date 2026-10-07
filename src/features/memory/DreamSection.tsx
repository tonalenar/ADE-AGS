import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BulkOutcome } from "./bulkReview";
import { approveDream, diffLines, reviewableDreams } from "./dreamReview";
import * as memoryIpc from "./ipc";
import type { MemoryDream } from "./types";

const DIFF_STYLE = { add: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", del: "bg-red-500/15 text-red-700 dark:text-red-300", ctx: "text-gray-500" } as const;

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
    try { for (const p of d.proposals) await memoryIpc.decideMemory(p.entryId, p.revision, false).catch(() => undefined); await load(); onChanged(); }
    finally { setBusy(false); }
  };

  const ready = reviewableDreams(dreams);
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => void start()} className="rounded border border-violet-500/60 px-2.5 py-1 text-[11px] font-medium text-violet-700 disabled:opacity-50 dark:text-violet-300">{t("memoryDream.start")}</button>
        {dreams.some((d) => d.status === "running") && <span role="status" className="text-[10.5px] text-gray-500">{t("memoryDream.running")}</span>}
        {message && <span role="status" className="text-[10.5px] text-gray-500">{message}</span>}
      </div>
      {ready.map((d) => {
        const title = t("memoryDream.group", { date: new Date(d.createdAt).toLocaleDateString() });
        return (
          <section key={d.dreamId} aria-label={title} className="mt-2 rounded-lg border border-violet-500/30 p-2.5">
            <h3 className="flex items-center gap-2 text-[12px] font-semibold">
              {title}
              <span className="text-[10.5px] font-normal text-gray-400">{t("memoryInbox.count", { count: d.proposals.length })}</span>
              <span className="flex-1" />
              <button type="button" disabled={busy} onClick={() => void approve(d)} aria-label={`${t("memoryDream.approveGroup")}: ${title}`} className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50">{t("memoryDream.approveGroup")}</button>
              <button type="button" disabled={busy} onClick={() => void reject(d)} aria-label={`${t("memoryDream.rejectGroup")}: ${title}`} className="rounded border border-gray-300 px-2 py-0.5 text-[11px] dark:border-white/20">{t("memoryDream.rejectGroup")}</button>
            </h3>
            <ul className="mt-1 list-disc pl-4 text-[11.5px]">
              {d.proposals.map((p) => (
                <li key={`${p.entryId}:${p.revision}`}>
                  <span className="font-medium">{p.operation ?? "update"} · {p.key}</span>
                  <span className="block whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{p.body}</span>
                  <span className="block text-[10.5px] text-gray-400">{p.evidence.reason ?? t("memoryReview.noEvidence")}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10.5px] font-semibold text-gray-500">{t("memoryDream.diff")}</p>
            <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-1.5 font-mono text-[10.5px] dark:bg-white/4" role="region" tabIndex={0} aria-label={t("memoryDream.diff")}>
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
