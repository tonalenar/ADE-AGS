import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMissionsStore } from "@/features/missions/store";
import {
  approveBulk, asksHighPriority, flatten, inboxKeyAction, groupsFromWorkspaceReview, itemId, normalizeGroups, planBulk, rejectBulk, selectedItems, totalPending,
  type BulkOutcome, type MissionReviewGroup,
} from "./bulkReview";
import { maxPendingPerOwner } from "./agentDrafts";
import { DraftsSection, type DraftsState } from "./DraftsSection";
import { DreamSection } from "./DreamSection";
import * as memoryIpc from "./ipc";
import { ReviewMarks } from "./ReviewMarks";
import { usePendingMemoryStore } from "./pendingStore";
import { isDeletion } from "./bulkReview";
import { evidenceParts, reviewFlag } from "./review";
import type { MemoryPendingCounts, MemoryReviewItem } from "./types";

/** Cuántas sugerencias pendientes hay en todas las misiones (lo que muestra el contador). */
export function pendingTotal(byMission: Record<string, number>): number {
  return Object.values(byMission).reduce((sum, n) => sum + (n > 0 ? n : 0), 0);
}

/** Botón de entrada al modal, con el contador de pendientes. */
export function MemoryInboxButton({ workspaceId, className = "" }: { workspaceId: string; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const counts = usePendingMemoryStore((s) => s.counts);
  const load = usePendingMemoryStore((s) => s.load);
  // El contador sale de la MISMA fuente que el modal (el resumen del workspace) para que coincidan;
  // si falla, cae a los conteos del store.
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void load(workspaceId).catch(() => undefined);
    memoryIpc.getWorkspaceReviewSummary(workspaceId)
      .then((r) => { if (alive) setTotal(totalPending(normalizeGroups(groupsFromWorkspaceReview(r, () => "")))); })
      .catch(() => { if (alive) setTotal(null); });
    return () => { alive = false; };
  }, [load, workspaceId, open]);
  const shown = total ?? pendingTotal(counts.byMission);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t("memoryInbox.open", { count: shown })}
        className={`flex items-center gap-1.5 rounded-md border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-100 dark:border-white/20 dark:text-gray-200 dark:hover:bg-white/8 ${className}`}>
        {t("memoryInbox.button")}
        {shown > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold leading-4 text-white">{shown}</span>}
      </button>
      {open && <MemoryInbox workspaceId={workspaceId} onClose={() => setOpen(false)} />}
    </>
  );
}

const FLAG_STYLE = {
  contradiction: "bg-red-500/15 text-red-600 dark:text-red-400",
  duplicate: "bg-gray-500/15 text-gray-500 dark:text-gray-400",
  highValue: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  normal: "",
} as const;

type Confirm = { items: MemoryReviewItem[] } | null;

/**
 * Modal único con TODAS las sugerencias pendientes del workspace, agrupadas por misión. Aceptar o
 * rechazar es siempre un clic del usuario; aceptar en masa pide confirmación con la cuenta y, si hay
 * contradicciones, un aviso explícito (sin confirmarlo no se aceptan).
 * Teclado: Esc cierra (o cancela la confirmación), Enter confirma SIN aceptar avisos.
 */
export function MemoryInbox({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const missions = useMissionsStore((s) => s.missions);
  const loadPending = usePendingMemoryStore((s) => s.load);
  const [groups, setGroups] = useState<MissionReviewGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [drafts, setDrafts] = useState<DraftsState>({ status: "loading" });
  // Contagens por dono (workspace e cada missão) para o aviso de caixa cheia; `null` = sem dado.
  const [ownerCounts, setOwnerCounts] = useState<MemoryPendingCounts | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const titles = useMemo(() => new Map(missions.map((m) => [m.id, m.title])), [missions]);

  const load = useCallback(async () => {
    try {
      const review = await memoryIpc.getWorkspaceReviewSummary(workspaceId);
      const found = groupsFromWorkspaceReview(review, (id) =>
        id === null ? t("memoryInbox.workspaceGroup") : titles.get(id) ?? id.slice(0, 8));
      const next = normalizeGroups(found);
      setGroups(next);
      // Lo elegido que ya no existe (se decidió en otro lado) se descarta.
      const live = new Set(flatten(next).map(itemId));
      setSelected((cur) => new Set([...cur].filter((id) => live.has(id))));
    } finally {
      setLoaded(true);
    }
  }, [workspaceId, titles, t]);

  const loadCounts = useCallback(() => {
    memoryIpc.getPendingCounts(workspaceId).then(setOwnerCounts).catch(() => setOwnerCounts(null));
  }, [workspaceId]);

  const loadDrafts = useCallback(() => {
    loadCounts();
    memoryIpc.listMemoryAgentDrafts(workspaceId)
      .then((d) => setDrafts({ status: "ready", drafts: Array.isArray(d) ? d : [] }))
      .catch(() => setDrafts({ status: "error" }));
  }, [workspaceId, loadCounts]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);
  useEffect(() => { root.current?.focus(); }, []);

  const all = useMemo(() => flatten(groups), [groups]);
  const chosen = useMemo(() => selectedItems(groups, selected), [groups, selected]);

  const finish = async (o: BulkOutcome) => {
    const parts: string[] = [];
    if (o.failed.length) parts.push(t("memoryReview.failed", { keys: o.failed.join(", ") }));
    if (o.skippedContradictions.length) parts.push(t("memoryInbox.skipped", { keys: o.skippedContradictions.join(", ") }));
    if (o.skippedDuplicates.length) parts.push(t("memoryInbox.skippedDuplicates", { keys: o.skippedDuplicates.join(", ") }));
    if (o.skippedDeletions.length) parts.push(t("memoryInbox.skippedDeletions", { keys: o.skippedDeletions.join(", ") }));
    setMessage(parts.join(" "));
    await load();
    loadCounts();
    await loadPending(workspaceId).catch(() => undefined);
    setBusy(false);
  };

  const approve = async (items: MemoryReviewItem[], acknowledge: boolean, explicit = false) => {
    if (busy || items.length === 0) return;
    setBusy(true);
    setConfirm(null);
    await finish(await approveBulk(items, memoryIpc.decideMemory, { acknowledgeContradictions: acknowledge, explicit }));
  };
  const reject = async (items: MemoryReviewItem[]) => {
    if (busy || items.length === 0) return;
    setBusy(true);
    await finish(await rejectBulk(items, memoryIpc.decideMemory));
  };
  /** Una sola: es una decisión puntual y explícita sobre ese item (también si contradice). */
  const approveOne = (item: MemoryReviewItem) => approve([item], true, true);

  const toggle = (id: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = inboxKeyAction(e.key, !!confirm);
    if (action.type === "close") { e.stopPropagation(); onClose(); }
    else if (action.type === "cancel-confirm") { e.stopPropagation(); setConfirm(null); }
    else if (action.type === "approve" && confirm) {
      e.preventDefault();
      void approve(confirm.items, action.acknowledge);
    }
  };

  const plan = confirm ? planBulk(confirm.items) : null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("memoryInbox.title")} onKeyDown={onKeyDown}
        className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-gray-200 bg-white text-gray-900 shadow-2xl outline-none dark:border-white/12 dark:bg-surface-deep dark:text-gray-50">
        <header className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-white/10">
          <h2 className="text-[14px] font-semibold">{t("memoryInbox.title")}</h2>
          <span className="rounded-full bg-amber-500 px-2 text-[11px] font-bold leading-5 text-white" aria-label={t("memoryInbox.count", { count: totalPending(groups) })}>{totalPending(groups)}</span>
          {drafts.status === "ready" && drafts.drafts.length > 0 && (
            <span className="rounded-full border border-amber-500/60 px-2 text-[11px] leading-5 text-amber-700 dark:text-amber-400" aria-label={t("memoryDrafts.headerLabel", { count: drafts.drafts.length })}>
              {t("memoryDrafts.headerCount", { count: drafts.drafts.length })}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label={t("memoryInbox.close")} className="rounded border border-gray-300 px-2 py-1 text-[11px] dark:border-white/20">Esc</button>
        </header>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-100 px-5 py-2 dark:border-white/6">
          <button type="button" disabled={busy || all.length === 0} onClick={() => setConfirm({ items: all })}
            className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50">{t("memoryInbox.approveAll")}</button>
          <button type="button" disabled={busy || chosen.length === 0} onClick={() => setConfirm({ items: chosen })}
            className="rounded bg-emerald-600/80 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50">{t("memoryInbox.approveSelected", { count: chosen.length })}</button>
          <button type="button" disabled={busy || all.length === 0} onClick={() => void reject(all)}
            className="rounded border border-gray-300 px-2.5 py-1 text-[11px] text-gray-700 disabled:opacity-50 dark:border-white/20 dark:text-gray-200">{t("memoryInbox.rejectAll")}</button>
          <button type="button" disabled={busy || chosen.length === 0} onClick={() => void reject(chosen)}
            className="rounded border border-gray-300 px-2.5 py-1 text-[11px] text-gray-700 disabled:opacity-50 dark:border-white/20 dark:text-gray-200">{t("memoryInbox.rejectSelected", { count: chosen.length })}</button>
          <span className="ml-auto text-[10.5px] text-gray-400 dark:text-white/35">{t("memoryReview.note")}</span>
        </div>

        <div className="px-5 pt-2"><DreamSection workspaceId={workspaceId} onChanged={(o) => { if (o) void finish(o); else void load(); }} /></div>

        {message && <p role="alert" className="px-5 pt-2 text-[11px] text-red-600 dark:text-red-400">{message}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <DraftsSection workspaceId={workspaceId} state={drafts} pending={maxPendingPerOwner(ownerCounts)} onReload={loadDrafts}
            onChanged={() => { loadDrafts(); void load(); void loadPending(workspaceId).catch(() => undefined); }} />
          {loaded && groups.length === 0 && <p className="py-10 text-center text-[12.5px] text-gray-500">{t("memoryInbox.empty")}</p>}
          {!loaded && <p className="py-10 text-center text-[12.5px] text-gray-500">{t("memoryInbox.loading")}</p>}
          {groups.map((g) => (
            <section key={g.missionId} className="mb-4" aria-label={g.title}>
              <h3 className="mb-1 flex items-center gap-2 text-[12px] font-semibold text-gray-700 dark:text-gray-200">
                <input type="checkbox" aria-label={t("memoryInbox.selectMission", { title: g.title })}
                  checked={g.items.every((i) => selected.has(itemId(i)))}
                  onChange={(e) => setSelected((cur) => {
                    const next = new Set(cur);
                    for (const i of g.items) { if (e.target.checked) next.add(itemId(i)); else next.delete(itemId(i)); }
                    return next;
                  })} />
                {g.title}
                <span className="text-[10.5px] font-normal text-gray-400">{t("memoryInbox.count", { count: g.items.length })}</span>
              </h3>
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-white/5 dark:border-white/10">
                {g.items.map((item) => {
                  const flag = reviewFlag(item);
                  const ev = evidenceParts(item);
                  const id = itemId(item);
                  return (
                    <li key={id} className="flex flex-col gap-1 p-2.5" data-flag={flag}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} aria-label={t("memoryInbox.selectItem", { key: item.key })} />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={item.key}>{item.key}</span>
                        {isDeletion(item) && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{t("memoryInbox.deletion")}</span>}
                        {asksHighPriority(item) && <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300" title={t("memoryInbox.highPriorityHint")}>{t("memoryInbox.highPriority", { priority: item.priority })}</span>}
                        {flag === "highValue" && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${FLAG_STYLE[flag]}`}>{t(`memoryReview.flag.${flag}`)}</span>}
                        <button type="button" disabled={busy} onClick={() => void approveOne(item)} aria-label={`${t("memoryReview.approve")}: ${item.key}`}
                          className="rounded bg-emerald-600/90 px-2 py-0.5 text-[11px] text-white disabled:opacity-50">{t("memoryReview.approve")}</button>
                        <button type="button" disabled={busy} onClick={() => void reject([item])} aria-label={`${t("memoryReview.reject")}: ${item.key}`}
                          className="rounded border border-gray-300 px-2 py-0.5 text-[11px] disabled:opacity-50 dark:border-white/20">{t("memoryReview.reject")}</button>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-[11.5px] text-gray-600 dark:text-gray-300">{item.body}</p>
                      <p className="text-[10.5px] text-gray-400 dark:text-white/35">
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
          ))}
        </div>

        {confirm && plan && (
          <div role="alertdialog" aria-modal="true" aria-label={t("memoryInbox.confirmTitle")}
            className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-black/40 p-6">
            <div className="max-w-md rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-white/12 dark:bg-surface-deep">
              <h3 className="text-[13px] font-semibold">{t("memoryInbox.confirmTitle")}</h3>
              <p className="mt-1 text-[12px]">{t("memoryInbox.confirmBody", { count: plan.total })}</p>
              {plan.needsWarning && (
                <div role="alert" className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11.5px] text-red-700 dark:text-red-300">
                  {t("memoryInbox.confirmContradictions", { count: plan.contradictions.length })}
                  <ul className="mt-1 list-disc pl-4">{plan.contradictions.map((c) => <li key={itemId(c)}>{c.key}</li>)}</ul>
                </div>
              )}
              {plan.duplicates > 0 && (
                <p className="mt-2 text-[11.5px] text-gray-600 dark:text-gray-300">{t("memoryInbox.confirmDuplicates", { count: plan.duplicates })}</p>
              )}
              {plan.deletions.length > 0 && (
                <div role="alert" className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11.5px] text-red-700 dark:text-red-300">
                  {t("memoryInbox.confirmDeletions", { count: plan.deletions.length })}
                  <ul className="mt-1 list-disc pl-4">{plan.deletions.map((d) => <li key={itemId(d)}>{d.key}</li>)}</ul>
                </div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirm(null)} className="rounded border border-gray-300 px-3 py-1 text-[11.5px] dark:border-white/20">{t("memoryInbox.cancel")}</button>
                {plan.needsWarning && (
                  <button type="button" onClick={() => void approve(confirm.items, true)} className="rounded border border-red-600 px-3 py-1 text-[11.5px] text-red-700 dark:text-red-300">
                    {t("memoryInbox.confirmAnyway")}
                  </button>
                )}
                <button type="button" autoFocus onClick={() => void approve(confirm.items, false)} className="rounded bg-emerald-600 px-3 py-1 text-[11.5px] font-medium text-white">
                  {(plan.needsWarning ? t("memoryInbox.confirmSkip") : t("memoryInbox.confirm")) + " (Enter)"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
