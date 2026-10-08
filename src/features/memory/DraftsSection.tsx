import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DRAFT_QUEUE_LIMIT, draftNotice, toDraftView } from "./agentDrafts";
import * as memoryIpc from "./ipc";
import type { MemoryAgentDraft } from "./types";

export type DraftsState = { status: "loading" } | { status: "error" } | { status: "ready"; drafts: MemoryAgentDraft[] };

/**
 * "Rascunhos de agente": propostas que esperam na fila porque a caixa de pendentes estava cheia.
 * Promover cria uma entrada PENDENTE (nunca aprova); descartar remove o rascunho. Conteúdo do
 * agente entra só como texto escapado.
 */
export function DraftsSection({
  workspaceId, state, pending, onReload, onChanged,
}: { workspaceId: string; state: DraftsState; pending: number | null; onReload: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, kind: "promote" | "discard") => {
    setBusyId(id);
    setError(null);
    try {
      if (kind === "promote") await memoryIpc.promoteMemoryAgentDraft(workspaceId, id);
      else await memoryIpc.discardMemoryAgentDraft(workspaceId, id);
      onChanged();
    } catch (e) {
      setError(t(kind === "promote" ? "memoryDrafts.promoteFailed" : "memoryDrafts.discardFailed", { detail: String(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const count = state.status === "ready" ? state.drafts.length : 0;
  const notice = draftNotice(count, pending);

  return (
    <section aria-label={t("memoryDrafts.title")} aria-busy={state.status === "loading"} className="mb-4">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-white/45">
        {t("memoryDrafts.title")}
        {state.status === "ready" && <span className="font-mono normal-case tracking-normal font-normal tabular-nums text-gray-400 dark:text-white/35">{t("memoryDrafts.count", { count, max: DRAFT_QUEUE_LIMIT })}</span>}
      </h3>
      {notice && (
        <div role="status" className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[11.5px] leading-4 text-amber-700 dark:text-amber-400">
          <b>{t(`memoryDrafts.notice.${notice}.title`)}</b> {t(`memoryDrafts.notice.${notice}.body`)}
        </div>
      )}
      {error && <p role="alert" className="mb-2 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      {state.status === "loading" && <p role="status" className="text-[11.5px] text-gray-500 dark:text-white/45">{t("memoryDrafts.loading")}</p>}
      {state.status === "error" && (
        <p role="alert" className="text-[11.5px] text-red-600 dark:text-red-400">
          {t("memoryDrafts.loadFailed")}{" "}
          <button type="button" onClick={onReload} className="underline">{t("memoryDrafts.retry")}</button>
        </p>
      )}
      {state.status === "ready" && count === 0 && <p className="text-[11.5px] text-gray-500 dark:text-white/45">{t("memoryDrafts.empty")}</p>}
      {state.status === "ready" && count > 0 && (
        <ul className="divide-y divide-gray-200 overflow-hidden rounded-xl bg-gray-100/70 dark:divide-white/[0.08] dark:bg-surface-raised/60">
          {state.drafts.map((d) => {
            const v = toDraftView(d);
            const busy = busyId !== null;
            return (
              <li key={v.id} className="flex flex-col gap-1.5 p-3" data-draft={v.id}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-gray-900 dark:text-gray-100" title={v.key ?? undefined}>
                    {v.key ?? t("memoryDrafts.unreadable")}
                  </span>
                  <span className="text-[10.5px] text-gray-500 dark:text-white/40">{t(`memoryReview.actor.${v.actorKind}`, { defaultValue: v.actorKind })}</span>
                  <button type="button" disabled={busy || !v.readable} onClick={() => void act(v.id, "promote")}
                    aria-label={`${t("memoryDrafts.promote")}: ${v.key ?? v.id}`}
                    className="h-6 rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{t("memoryDrafts.promote")}</button>
                  <button type="button" disabled={busy} onClick={() => void act(v.id, "discard")}
                    aria-label={`${t("memoryDrafts.discard")}: ${v.key ?? v.id}`}
                    className="h-6 rounded-md bg-gray-200/80 px-2.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300/70 disabled:opacity-50 dark:bg-surface-overlay dark:text-gray-100 dark:hover:bg-white/[0.14]">{t("memoryDrafts.discard")}</button>
                </div>
                {v.body && <p className="whitespace-pre-wrap break-words text-[11.5px] leading-4 text-gray-600 dark:text-gray-300">{v.body}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[10.5px] leading-[14px] text-gray-500 dark:text-white/35">{t("memoryDrafts.note")}</p>
    </section>
  );
}
