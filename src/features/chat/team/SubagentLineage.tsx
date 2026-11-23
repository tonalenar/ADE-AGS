import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { selectConversation } from "@/features/chat/unified/selectionActions";

import { chatTeamStates } from "./ipc";
import { buildLineage, formatElapsed, stateLabelKey, waitingSummary, type Lineage, type LineageEntry, type MemberStateRow } from "./lineageModel";
import { AgentMono } from "./TeamParts";
import { interruptThread, useStructured } from "../structured/store";
import { threadKey, threadStatusSignature } from "../structured/model";

/**
 * A linhagem de uma conversa para a tela: relê o estado real do backend quando muda a fase, um pedido ou o conjunto
 * de filhos (a assinatura), nunca por relógio. Só o tempo decorrido corre na tela, uma vez por segundo, e só com filho rodando.
 */
export function useLineage(threadId: string): { lineage: Lineage; now: number } {
  const threads = useStructured((s) => s.threads);
  const childIds = useMemo(() => threads.filter((t) => t.parentRef === `thread:${threadId}`).map((t) => t.id), [threads, threadId]);
  const [states, setStates] = useState<MemberStateRow[]>([]);
  const signature = useStructured((s) => threadStatusSignature(s.live, [threadId, ...childIds]));
  useEffect(() => {
    let alive = true;
    chatTeamStates().then((rows) => { if (alive && Array.isArray(rows)) setStates(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [signature, childIds.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps -- relê só quando algo muda
  const lineage = useMemo(
    () => buildLineage(threadId, threads, states, (id) => useStructured.getState().live[id]?.phase),
    [threadId, threads, states, signature], // eslint-disable-line react-hooks/exhaustive-deps -- `signature` cobre a fase ao vivo
  );
  const [now, setNow] = useState(() => Date.now());
  const running = lineage.running.length > 0;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return { lineage, now };
}

/**
 * Com um subagente rodando, uma linha: "Trabalhando · título · 2h 35m 50s · Detalhes · Parar". Com vários, a linha do
 * T3 Code: "Aguardando N subagentes · nomes · Detalhes · Parar" (Detalhes abre uma linha por subagente; Parar interrompe todos).
 */
export function SubagentStatusLines({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const { lineage, now } = useLineage(threadId);
  const [expanded, setExpanded] = useState(false);
  const running = lineage.running;
  if (running.length === 0) return null;
  const perAgent = (
    <>
      {running.map((entry) => (
        <div key={entry.threadId} className="flex items-center gap-2 min-w-0 text-chat-note text-gray-500 dark:text-white/50">
          <span className="shrink-0">{t(stateLabelKey(entry.state))}</span>
          <span className="shrink-0">·</span>
          <span className="truncate min-w-0" title={entry.title}>{entry.title}</span>
          <span className="shrink-0 tabular-nums">{formatElapsed(now - entry.startedAt)}</span>
          <button type="button" onClick={() => selectConversation(threadKey(entry.threadId))}
            className="shrink-0 font-medium text-gray-900 dark:text-white hover:underline">{t("chat.lineage.details")}</button>
          <button type="button" onClick={() => interruptThread(entry.threadId)}
            className="shrink-0 font-medium text-gray-900 dark:text-white hover:underline">{t("chat.lineage.stop")}</button>
        </div>
      ))}
    </>
  );
  if (running.length === 1) {
    return <div role="group" aria-label={t("chat.lineage.title", { n: 1 })} className="flex flex-col gap-0.5 px-1 py-1">{perAgent}</div>;
  }
  const summary = waitingSummary(running);
  return (
    <div role="group" aria-label={t("chat.lineage.title", { n: summary.count })} className="flex flex-col gap-0.5 px-1 py-1">
      <div className="flex items-center gap-2 min-w-0 text-chat-note text-gray-500 dark:text-white/50">
        <span className="shrink-0">{t("chat.lineage.waiting", { count: summary.count })}</span>
        <span className="truncate min-w-0" title={summary.names}>{summary.names}</span>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
          className="shrink-0 font-medium text-gray-900 dark:text-white hover:underline">{expanded ? t("chat.lineage.hideDetails") : t("chat.lineage.details")}</button>
        <button type="button" title={t("chat.lineage.stopAll")} onClick={() => running.forEach((entry) => interruptThread(entry.threadId))}
          className="shrink-0 font-medium text-gray-900 dark:text-white hover:underline">{t("chat.lineage.stop")}</button>
      </div>
      {expanded && perAgent}
    </div>
  );
}

/** O painel "Linhagem · N em execução": os filhos ativos com o tempo e o histórico (concluídos e com erro). */
export function LineagePanel({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const { lineage, now } = useLineage(threadId);
  const [showPrevious, setShowPrevious] = useState(false);
  if (lineage.running.length === 0 && lineage.previous.length === 0) return null;
  const row = (entry: LineageEntry, live: boolean) => (
    <li key={entry.threadId}>
      <button type="button" onClick={() => selectConversation(threadKey(entry.threadId))}
        className="w-full flex items-center gap-2 h-8 px-1 rounded-lg text-left text-chat-note text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.06]">
        <AgentMono agentId={entry.agentId} label={entry.agentId} size={14} />
        <span className="flex-1 min-w-0 truncate">{entry.title}</span>
        <span className={`shrink-0 text-chat-caption ${entry.state === "failed" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-white/45"}`}>
          {live ? formatElapsed(now - entry.startedAt) : t(stateLabelKey(entry.state))}
        </span>
      </button>
    </li>
  );
  return (
    <section aria-label={t("chat.lineage.panel")} className="rounded-xl border border-gray-200 dark:border-white/[0.08] px-3 py-2 text-chat-note">
      <div className="text-chat-caption text-gray-500 dark:text-white/45">{t("chat.lineage.title", { n: lineage.running.length })}</div>
      <ul className="m-0 p-0 list-none">{lineage.running.map((e) => row(e, true))}</ul>
      {lineage.previous.length > 0 && (
        <>
          <button type="button" aria-expanded={showPrevious} onClick={() => setShowPrevious(!showPrevious)}
            className="w-full flex items-center gap-2 h-8 px-1 rounded-lg text-left text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            <span className="flex-1">{t("chat.lineage.previous")}</span>
            {lineage.failed > 0 && <span className="text-red-600 dark:text-red-400">{t("chat.lineage.failedCount", { n: lineage.failed })}</span>}
            <span className="text-gray-500 dark:text-white/45">{lineage.previous.length}</span>
          </button>
          {showPrevious && <ul className="m-0 p-0 list-none">{lineage.previous.map((e) => row(e, false))}</ul>}
        </>
      )}
    </section>
  );
}
