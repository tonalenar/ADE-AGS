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
import { RepoSyncNotice } from "./RepoSyncNotice";
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

/** Botão de entrada al modal, con el contador de pendientes. */
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
        className={`flex h-7 items-center gap-1.5 rounded-md bg-gray-200/70 px-2.5 text-[12px] font-medium text-gray-800 hover:bg-gray-300/70 dark:bg-surface-raised dark:text-gray-200 dark:hover:bg-white/[0.1] ${className}`}>
        {t("memoryInbox.button")}
        {shown > 0 && <span className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1.5 font-mono text-[10px] font-bold tabular-nums text-white">{shown}</span>}
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

/** Botones del modal: primario verde para aprobar, secundario gris para rechazar. */
const BTN_OK = "h-7 rounded-md bg-emerald-600 px-3 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50";
const BTN_SEC = "h-7 rounded-md bg-gray-200/80 px-3 text-[12px] font-medium text-gray-800 hover:bg-gray-300/70 disabled:opacity-50 dark:bg-surface-overlay dark:text-gray-100 dark:hover:bg-white/[0.14]";
const BTN_ITEM_OK = "h-7 rounded-[7px] bg-[#34c759] px-3 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] hover:brightness-110 disabled:opacity-50 dark:bg-[#30d158]";
const BTN_ITEM_SEC = "h-7 rounded-[7px] bg-gray-200/80 px-3 text-[13px] font-medium text-gray-800 hover:bg-gray-300/70 disabled:opacity-50 dark:bg-surface-overlay dark:text-gray-100 dark:hover:brightness-110";

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
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("memoryInbox.title")} onKeyDown={onKeyDown}
        className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-gray-50 text-gray-900 shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] outline-none dark:bg-surface dark:text-gray-50">
        <header className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-5 py-3.5 dark:border-white/[0.08]">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{t("memoryInbox.title")}</h2>
          <span className="inline-flex h-[18px] items-center rounded-full bg-amber-500/15 px-2 font-mono text-[10.5px] font-semibold tabular-nums text-amber-700 dark:text-amber-300" aria-label={t("memoryInbox.count", { count: totalPending(groups) })}>{totalPending(groups)}</span>
          {drafts.status === "ready" && drafts.drafts.length > 0 && (
            <span className="inline-flex h-[18px] items-center rounded-full bg-amber-500/15 px-2 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300" aria-label={t("memoryDrafts.headerLabel", { count: drafts.drafts.length })}>
              {t("memoryDrafts.headerCount", { count: drafts.drafts.length })}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label={t("memoryInbox.close")} className="inline-flex h-5 items-center rounded-[5px] bg-gray-200 px-1.5 font-mono text-[11px] text-gray-600 shadow-[inset_0_-1px_0_rgba(0,0,0,0.2)] dark:bg-surface-overlay dark:text-white/60 dark:shadow-[inset_0_-1px_0_rgba(0,0,0,0.45)]">Esc</button>
        </header>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-5 py-2.5 dark:border-white/[0.08]">
          <button type="button" disabled={busy || all.length === 0} onClick={() => setConfirm({ items: all })}
            className={BTN_OK}>{t("memoryInbox.approveAll")}</button>
          <button type="button" disabled={busy || chosen.length === 0} onClick={() => setConfirm({ items: chosen })}
            className={BTN_OK}>{t("memoryInbox.approveSelected", { count: chosen.length })}</button>
          <button type="button" disabled={busy || all.length === 0} onClick={() => void reject(all)}
            className={BTN_SEC}>{t("memoryInbox.rejectAll")}</button>
          <button type="button" disabled={busy || chosen.length === 0} onClick={() => void reject(chosen)}
            className={BTN_SEC}>{t("memoryInbox.rejectSelected", { count: chosen.length })}</button>
          <span className="ml-auto text-[10.5px] text-gray-500 dark:text-white/40">{t("memoryReview.note")}</span>
        </div>

        <div className="px-5 pt-2.5 empty:hidden"><RepoSyncNotice workspaceId={workspaceId} /></div>
        <div className="px-5 pt-2.5"><DreamSection workspaceId={workspaceId} onChanged={(o) => { if (o) void finish(o); else void load(); }} /></div>

        {message && <p role="alert" className="px-5 pt-2 text-[11px] text-red-600 dark:text-red-400">{message}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <DraftsSection workspaceId={workspaceId} state={drafts} pending={maxPendingPerOwner(ownerCounts)} onReload={loadDrafts}
            onChanged={() => { loadDrafts(); void load(); void loadPending(workspaceId).catch(() => undefined); }} />
          {loaded && groups.length === 0 && <p className="py-10 text-center text-[12.5px] text-gray-500 dark:text-white/45">{t("memoryInbox.empty")}</p>}
          {!loaded && <p className="py-10 text-center text-[12.5px] text-gray-500 dark:text-white/45">{t("memoryInbox.loading")}</p>}
          {groups.map((g) => (
            <section key={g.missionId} className="mb-4" aria-label={g.title}>
              <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-gray-900 dark:text-gray-100">
                <input type="checkbox" className="size-3.5 accent-accent-500" aria-label={t("memoryInbox.selectMission", { title: g.title })}
                  checked={g.items.every((i) => selected.has(itemId(i)))}
                  onChange={(e) => setSelected((cur) => {
                    const next = new Set(cur);
                    for (const i of g.items) { if (e.target.checked) next.add(itemId(i)); else next.delete(itemId(i)); }
                    return next;
                  })} />
                {g.title}
                <span className="font-mono text-[10.5px] font-normal tabular-nums text-gray-500 dark:text-white/40">{t("memoryInbox.count", { count: g.items.length })}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {g.items.map((item) => {
                  const flag = reviewFlag(item);
                  const ev = evidenceParts(item);
                  const id = itemId(item);
                  return (
                    <li key={id} data-flag={flag}
                      className={`flex flex-col gap-1.5 rounded-[10px] p-3 transition-colors ${selected.has(id)
                        ? "bg-accent-500/[0.06] shadow-[inset_0_0_0_1px_var(--color-accent-500)]"
                        : "bg-white shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)] dark:bg-surface-raised/60 dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)]"}`}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" className="size-3.5 accent-accent-500" checked={selected.has(id)} onChange={() => toggle(id)} aria-label={t("memoryInbox.selectItem", { key: item.key })} />
                        <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px] font-semibold text-gray-900 dark:text-[#f5f5f7]" title={item.key}>{item.key}</span>
                        {isDeletion(item) && <span className="inline-flex h-[18px] items-center rounded-full bg-red-600 px-2 text-[10px] font-bold text-white">{t("memoryInbox.deletion")}</span>}
                        {asksHighPriority(item) && <span className="inline-flex h-[18px] items-center rounded-full bg-amber-500/15 px-2 text-[10px] font-semibold text-amber-700 dark:text-amber-300" title={t("memoryInbox.highPriorityHint")}>{t("memoryInbox.highPriority", { priority: item.priority })}</span>}
                        {flag === "highValue" && <span className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10px] font-semibold ${FLAG_STYLE[flag]}`}>{t(`memoryReview.flag.${flag}`)}</span>}
                      </div>
                      <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[17px] text-gray-600 dark:text-white/60">{item.body}</p>
                      <p className="font-mono text-[10.5px] leading-[14px] text-gray-500 dark:text-white/40">
                        {t("memoryReview.evidence")}: {t(`memoryReview.actor.${item.evidence.actorKind}`)}
                        {ev.runId ? ` · run ${ev.runId.slice(0, 8)}` : ""}
                        {ev.taskId ? ` · task ${ev.taskId.slice(0, 8)}` : ""}
                        {ev.factId ? ` · fact ${ev.factId.slice(0, 8)}` : ""}
                        {ev.reason ? ` · ${ev.reason}` : ""}
                        {!ev.runId && !ev.taskId && !ev.factId && !ev.reason ? ` · ${t("memoryReview.noEvidence")}` : ""}
                      </p>
                      <ReviewMarks item={item} />
                      <div className="mt-1 flex items-center gap-2">
                        <button type="button" disabled={busy} onClick={() => void approveOne(item)} aria-label={`${t("memoryReview.approve")}: ${item.key}`}
                          className={BTN_ITEM_OK}>{t("memoryReview.approve")}</button>
                        <button type="button" disabled={busy} onClick={() => void reject([item])} aria-label={`${t("memoryReview.reject")}: ${item.key}`}
                          className={BTN_ITEM_SEC}>{t("memoryReview.reject")}</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        {confirm && plan && (
          <div role="alertdialog" aria-modal="true" aria-label={t("memoryInbox.confirmTitle")}
            className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-black/45 p-6 backdrop-blur-[4px]">
            <div className="max-w-md rounded-2xl bg-gray-50 p-5 shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] dark:bg-surface">
              <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{t("memoryInbox.confirmTitle")}</h3>
              <p className="mt-1.5 text-[12.5px] leading-[17px] text-gray-700 dark:text-gray-300">{t("memoryInbox.confirmBody", { count: plan.total })}</p>
              {plan.needsWarning && (
                <div role="alert" className="mt-3 rounded-lg bg-red-500/10 p-2.5 text-[11.5px] text-red-700 dark:text-red-300">
                  {t("memoryInbox.confirmContradictions", { count: plan.contradictions.length })}
                  <ul className="mt-1 list-disc pl-4">{plan.contradictions.map((c) => <li key={itemId(c)}>{c.key}</li>)}</ul>
                </div>
              )}
              {plan.duplicates > 0 && (
                <p className="mt-3 text-[11.5px] text-gray-600 dark:text-gray-300">{t("memoryInbox.confirmDuplicates", { count: plan.duplicates })}</p>
              )}
              {plan.deletions.length > 0 && (
                <div role="alert" className="mt-3 rounded-lg bg-red-500/10 p-2.5 text-[11.5px] text-red-700 dark:text-red-300">
                  {t("memoryInbox.confirmDeletions", { count: plan.deletions.length })}
                  <ul className="mt-1 list-disc pl-4">{plan.deletions.map((d) => <li key={itemId(d)}>{d.key}</li>)}</ul>
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirm(null)} className={BTN_SEC}>{t("memoryInbox.cancel")}</button>
                {plan.needsWarning && (
                  <button type="button" onClick={() => void approve(confirm.items, true)} className="h-7 rounded-md border border-red-500/60 px-3 text-[12px] text-red-700 hover:bg-red-500/10 dark:text-red-300">
                    {t("memoryInbox.confirmAnyway")}
                  </button>
                )}
                <button type="button" autoFocus onClick={() => void approve(confirm.items, false)} className={BTN_OK}>
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
