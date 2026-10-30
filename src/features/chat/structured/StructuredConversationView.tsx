import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useTabsStore } from "@/features/tabs/store";

import { AccessMenu } from "../AccessMenu";
import { AgentModelPicker, EffortMenu } from "../AgentModelPicker";
import { accessModesFor, type ConversationCard } from "../chatModel";
import { ChatComposer } from "../ChatComposer";
import { ContextStrip } from "../NewConversation";
import { TimelineView, type ApprovalNote } from "../timeline/ConversationTimeline";
import type { RequestRow, ThreadRow } from "./ipc";
import { EMPTY_LIVE } from "./model";
import { answerRequest, hydrateThread, interruptThread, retuneThread, sendToThread, useStructured } from "./store";

/**
 * Uma conversa por protocolo (o Codex pelo `app-server`): a mesma timeline e o mesmo composer das
 * outras, mas sem terminal. Aprovações e perguntas chegam como pedidos do agente e se respondem
 * aqui; parar interrompe o turno; modelo, esforço e acesso valem a partir do próximo turno.
 */
export function StructuredConversationView({ card, thread }: { card: ConversationCard; thread: ThreadRow }) {
  const { t } = useTranslation();
  const live = useStructured((s) => s.live[thread.id]) ?? EMPTY_LIVE;
  const agentInfo = useTabsStore((s) => s.detectedAgents.find((a) => a.id === thread.agentId))
    ?? { id: thread.agentId, label: card.agentLabel, command: "", available: true };
  const hydrated = useStructured((s) => !!s.hydrated[thread.id]);
  useEffect(() => hydrateThread(thread.id), [thread.id]);

  const request: RequestRow | null = live.requests[0] ?? null;
  const working = live.phase === "working";
  const locked = working || !!request;
  const question = request?.kind === "question" ? request.options?.[0] ?? null : null;
  const note: ApprovalNote | null = request
    ? {
      title: request.kind === "question" ? request.title
        : request.title || t(request.kind === "command" ? "chat.structured.command" : "chat.structured.fileChange"),
      detail: request.detail || null,
    }
    : null;
  const answer = (choice: string) => { if (request) answerRequest(thread.id, request.id, choice); };

  const controls = request ? (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {question ? question.options.map((o) => <ApprovalButton key={o} onClick={() => answer(o)}>{o}</ApprovalButton>) : (
        <>
          <ApprovalButton onClick={() => answer("deny")}>{t("chat.approval.deny")}</ApprovalButton>
          <ApprovalButton onClick={() => answer("allowSession")}>{t("chat.approval.session")}</ApprovalButton>
          <ApprovalButton primary onClick={() => answer("allow")}>{t("chat.approval.allow")}</ApprovalButton>
        </>
      )}
    </div>
  ) : (
    <div title={locked ? t("chat.composer.lockedWhileWorking") : undefined} className="flex items-center gap-0.5">
      <AgentModelPicker agents={[agentInfo]} showAccount={false} disabled={locked}
        value={{ agentId: thread.agentId, model: thread.model, effort: thread.effort, account: null }}
        onChange={(v) => retuneThread(thread.id, v.model, thread.effort, thread.access)} />
      <EffortMenu agentId={thread.agentId} model={thread.model} account={null} value={thread.effort} disabled={locked}
        onChange={(effort) => retuneThread(thread.id, thread.model, effort, thread.access)} />
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TimelineView items={live.items} loaded={hydrated} working={working || !!request}
        approval={note} draft={live.draft?.text ?? null} agentLabel={card.agentLabel} />
      <div className="w-full max-w-[736px] mx-auto px-4 sm:px-12 pb-3">
        {live.error && <p role="alert" className="mb-2 px-1 text-[12.5px] text-red-600 dark:text-red-400 break-words">{live.error}</p>}
        <ChatComposer cwd={thread.cwd}
          placeholder={question ? t("chat.structured.answer") : request ? t("chat.composer.redirect") : t("chat.composer.reply")}
          onSubmit={(text) => { if (question) answer(text); else sendToThread(thread.id, text); }}
          onStop={working && !request ? () => interruptThread(thread.id) : null}
          controls={controls} />
        <ContextStrip branch={card.branch} worktree={card.isWorktree}>
          <AccessMenu value={thread.access} available={accessModesFor(thread.agentId)}
            onChange={locked ? undefined : (next) => retuneThread(thread.id, thread.model, thread.effort, next)} />
        </ContextStrip>
      </div>
    </div>
  );
}

function ApprovalButton({ primary = false, onClick, children }: { primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`h-6 px-2 rounded-md text-[12px] font-medium
        ${primary ? "bg-accent-600 text-white hover:bg-accent-700" : "border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] text-gray-800 dark:text-white/80 hover:bg-gray-50 dark:hover:bg-white/[0.08]"}`}>
      {children}
    </button>
  );
}
