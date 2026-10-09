import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMissionsStore } from "@/features/missions/store";
import { approveBulk, flatten, groupsFromWorkspaceReview, normalizeGroups, rejectBulk } from "./bulkReview";
import * as memoryIpc from "./ipc";
import { usePendingMemoryStore } from "./pendingStore";
import { evidenceParts, reviewMarks, sortReviewItems } from "./review";
import { SourceCheck } from "./SourceCheck";
import type { MemoryEntry, MemoryReviewItem } from "./types";

/**
 * O painel de memória da tela de Configurações (prancheta 5): as sugestões pendentes do workspace,
 * com as abas Pendentes / Aprovadas / Rejeitadas, busca e filtros por suspeita.
 *
 * Aprovar e rejeitar são sempre um clique seu, como na caixa de sugestões das Missões — aqui só
 * mora ao lado do que você está ajustando, em vez de num modal.
 */
type Tab = "pending" | "approved" | "rejected";
type Flag = "duplicate" | "contradiction" | "highValue";

const MARK_STYLE = {
  duplicate: "bg-yellow-500/15 text-yellow-700 dark:text-[#ffd60a]",
  contradiction: "bg-orange-500/15 text-orange-700 dark:text-[#ff9f0a]",
} as const;

const BTN_OK = "h-7 rounded-[7px] bg-[#34c759] px-3 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] hover:brightness-110 disabled:opacity-50 dark:bg-[#30d158]";
const BTN_SEC = "h-7 rounded-[7px] bg-gray-200/80 px-3 text-[13px] font-medium text-gray-800 hover:bg-gray-300/70 disabled:opacity-50 dark:bg-surface-overlay dark:text-gray-100 dark:hover:brightness-110";

export function MemoryPanel({ workspaceId, workspaceName, onOpenMemory }: {
  workspaceId: string;
  workspaceName: string;
  /** O ícone do cabeçalho leva à seção Memória (a lista completa). */
  onOpenMemory?: () => void;
}) {
  const { t } = useTranslation();
  const missions = useMissionsStore((s) => s.missions);
  const loadPending = usePendingMemoryStore((s) => s.load);
  const [tab, setTab] = useState<Tab>("pending");
  const [query, setQuery] = useState("");
  const [flags, setFlags] = useState<Set<Flag>>(new Set());
  const [pending, setPending] = useState<MemoryReviewItem[]>([]);
  const [entries, setEntries] = useState<Record<"approved" | "rejected", MemoryEntry[] | null>>({ approved: null, rejected: null });
  const [entriesError, setEntriesError] = useState<Partial<Record<"approved" | "rejected", string>>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const titles = useMemo(() => new Map(missions.map((m) => [m.id, m.title])), [missions]);

  const loadReview = useCallback(async () => {
    try {
      const review = await memoryIpc.getWorkspaceReviewSummary(workspaceId);
      const groups = normalizeGroups(groupsFromWorkspaceReview(review, (id) =>
        id === null ? t("memoryInbox.workspaceGroup") : titles.get(id) ?? id.slice(0, 8)));
      setPending(sortReviewItems(flatten(groups)));
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLoaded(true);
    }
  }, [workspaceId, titles, t]);

  const loadEntries = useCallback(async (which: "approved" | "rejected") => {
    try {
      const page = await memoryIpc.queryMemory(workspaceId, null, { status: which });
      setEntries((cur) => ({ ...cur, [which]: Array.isArray(page?.items) ? page.items : [] }));
      setEntriesError((cur) => ({ ...cur, [which]: undefined }));
    } catch (e) {
      // Falha não é "nenhuma memória": mostra o erro e deixa a aba tentar de novo ao voltar.
      setEntries((cur) => ({ ...cur, [which]: [] }));
      setEntriesError((cur) => ({ ...cur, [which]: String(e) }));
    }
  }, [workspaceId]);

  useEffect(() => { void loadReview(); }, [loadReview]);
  useEffect(() => {
    if (tab !== "pending" && entries[tab] === null) void loadEntries(tab);
  }, [tab, entries, loadEntries]);

  const decide = async (item: MemoryReviewItem, approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const outcome = approve
        ? await approveBulk([item], memoryIpc.decideMemory, { acknowledgeContradictions: true, explicit: true })
        : await rejectBulk([item], memoryIpc.decideMemory);
      if (outcome.failed.length) setMessage(t("memoryReview.failed", { keys: outcome.failed.join(", ") }));
      await loadReview();
      setEntries({ approved: null, rejected: null });
      await loadPending(workspaceId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const shownPending = pending.filter((item) => {
    if (q && !item.key.toLowerCase().includes(q) && !item.body.toLowerCase().includes(q)) return false;
    if (flags.has("duplicate") && !item.duplicateOf) return false;
    if (flags.has("contradiction") && !item.contradicts) return false;
    if (flags.has("highValue") && !item.highValue) return false;
    return true;
  });
  const shownEntries = (tab === "pending" ? [] : entries[tab] ?? []).filter((e) =>
    !q || e.key.toLowerCase().includes(q) || (e.body ?? "").toLowerCase().includes(q));
  const toggleFlag = (f: Flag) => setFlags((cur) => {
    const next = new Set(cur);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  return (
    <section aria-label={t("memoryPanel.title")}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.08)] dark:bg-surface dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.06)]">
      <header className="flex shrink-0 items-start gap-2 px-4 pb-3 pt-4 pr-12">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] leading-5 font-semibold text-gray-900 dark:text-[#f5f5f7]">{t("memoryPanel.title")}</h2>
          <p className="truncate text-[11.5px] leading-4 text-gray-500 dark:text-white/55">
            {workspaceName} · {t("memoryPanel.subtitle", { count: pending.length })}
          </p>
        </div>
        {onOpenMemory && (
          <button type="button" onClick={onOpenMemory} title={t("memoryPanel.openMemory")} aria-label={t("memoryPanel.openMemory")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-gray-500 hover:text-gray-900 dark:bg-white/[0.07] dark:text-white/55 dark:hover:text-white">
            <svg viewBox="0 0 18 18" aria-hidden className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="m9 2.5 6.5 3.2L9 8.9 2.5 5.7 9 2.5Z" /><path d="m2.5 9 6.5 3.2L15.5 9M2.5 12.3 9 15.5l6.5-3.2" /></svg>
          </button>
        )}
      </header>

      <div className="flex shrink-0 flex-col gap-2.5 px-4 pb-3">
        <label className="flex h-8 items-center gap-2 rounded-[10px] bg-black/[0.05] pl-2.5 pr-2 text-gray-400 focus-within:ring-[3px] focus-within:ring-accent-500/25 dark:bg-surface-raised dark:text-white/30">
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" className="h-[15px] w-[15px] shrink-0" aria-hidden><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2 16 16" /></svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("memoryPanel.search")} aria-label={t("memoryPanel.search")}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-white/30" />
        </label>

        <div role="tablist" aria-label={t("memoryPanel.title")} className="flex rounded-[9px] bg-black/[0.05] p-0.5 dark:bg-surface-raised">
          {(["pending", "approved", "rejected"] as const).map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} onClick={() => setTab(x)}
              className={`flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[12.5px] font-medium transition-colors ${tab === x
                ? "bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-surface-overlay dark:text-white dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                : "text-gray-500 hover:text-gray-800 dark:text-white/55 dark:hover:text-white"}`}>
              {t(`memoryPanel.tab.${x}`)}
              {x === "pending" && pending.length > 0 && (
                <span className="rounded-full bg-accent-500/20 px-1.5 font-mono text-[10.5px] tabular-nums text-accent-600 dark:text-accent-400">{pending.length}</span>
              )}
            </button>
          ))}
        </div>

        {tab === "pending" && (
          <div className="flex flex-wrap gap-1.5">
            {(["duplicate", "contradiction", "highValue"] as const).map((f) => (
              <button key={f} type="button" aria-pressed={flags.has(f)} onClick={() => toggleFlag(f)}
                className={`inline-flex h-6 items-center rounded-full px-2.5 text-[11.5px] font-medium transition-colors ${flags.has(f)
                  ? "bg-accent-500/20 text-accent-600 dark:text-accent-400"
                  : "bg-black/[0.05] text-gray-600 hover:bg-black/[0.08] dark:bg-white/[0.07] dark:text-white/70 dark:hover:bg-white/[0.11]"}`}>
                {t(`memoryPanel.chip.${f}`)}
              </button>
            ))}
          </div>
        )}
        {message && <p role="alert" className="text-[11.5px] text-red-600 dark:text-red-400">{message}</p>}
      </div>

      <div className="cc-scroll min-h-0 flex-1 px-4 pb-4">
        {tab === "pending" ? (
          !loaded ? <p className="py-8 text-center text-[12.5px] text-gray-400 dark:text-white/35">{t("memoryInbox.loading")}</p>
          : shownPending.length === 0 ? <p className="py-8 text-center text-[12.5px] text-gray-400 dark:text-white/35">{pending.length === 0 ? t("memoryPanel.empty.pending") : t("memoryPanel.empty.filtered")}</p>
          : (
            <ul className="flex flex-col gap-2.5">
              {shownPending.map((item) => {
                const ev = evidenceParts(item);
                const src = [ev.runId && `run ${ev.runId.slice(0, 8)}`, ev.taskId && `task ${ev.taskId.slice(0, 8)}`, ev.factId && `fact ${ev.factId.slice(0, 8)}`, ev.reason]
                  .filter(Boolean).join(" · ") || t("memoryReview.noEvidence");
                return (
                  <li key={`${item.entryId}:${item.revision}`}
                    className="flex flex-col gap-2 rounded-[10px] bg-white p-3 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent-500)] dark:bg-surface-raised/60 dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)] dark:focus-within:shadow-[inset_0_0_0_1px_var(--color-accent-500)]">
                    <h3 className="text-[13.5px] leading-[18px] font-semibold text-gray-900 dark:text-[#f5f5f7] [overflow-wrap:anywhere]">{item.key}</h3>
                    {reviewMarks(item).length > 0 && (
                      <ul className="flex flex-wrap gap-1.5">
                        {reviewMarks(item).map((m) => (
                          <li key={m.kind} className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10.5px] font-semibold ${MARK_STYLE[m.kind]}`}>
                            {t(m.kind === "duplicate" ? "memoryPanel.mark.duplicate" : "memoryPanel.mark.contradiction")}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[17px] text-gray-600 dark:text-white/60">{item.body}</p>
                    <p className="font-mono text-[10.5px] leading-[14px] text-gray-400 dark:text-white/35">{t("memoryPanel.source", { src })}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" disabled={busy} onClick={() => void decide(item, true)} className={BTN_OK}>{t("memoryReview.approve")}</button>
                      <button type="button" disabled={busy} onClick={() => void decide(item, false)} className={BTN_SEC}>{t("memoryReview.reject")}</button>
                      <span className="ml-auto"><SourceCheck entryId={item.entryId} disabled={busy} /></span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : entriesError[tab as "approved" | "rejected"] ? (
          <p role="alert" className="py-8 text-center text-[12.5px] text-red-600 dark:text-red-400">{entriesError[tab as "approved" | "rejected"]}</p>
        ) : entries[tab] === null ? (
          <p className="py-8 text-center text-[12.5px] text-gray-400 dark:text-white/35">{t("memoryInbox.loading")}</p>
        ) : shownEntries.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-gray-400 dark:text-white/35">{t(`memoryPanel.empty.${tab}`)}</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {shownEntries.map((e) => (
              <li key={e.id} className="flex flex-col gap-1.5 rounded-[10px] bg-white p-3 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)] dark:bg-surface-raised/60 dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.06)]">
                <div className="flex items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px] font-semibold text-gray-900 dark:text-[#f5f5f7]" title={e.key}>{e.key}</h3>
                  <span className="shrink-0 rounded-full bg-black/[0.06] px-2 text-[10.5px] leading-[18px] text-gray-500 dark:bg-white/[0.08] dark:text-white/60">{e.kind}</span>
                </div>
                {e.body && <p className="line-clamp-4 whitespace-pre-wrap break-words text-[12.5px] leading-[17px] text-gray-600 dark:text-white/60">{e.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
