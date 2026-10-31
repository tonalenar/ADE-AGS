import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useTabsStore } from "@/features/tabs/store";

import { AccessMenu } from "../AccessMenu";
import { turnLive } from "../activityModel";
import { AgentModelPicker, EffortMenu } from "../AgentModelPicker";
import { BotIcon } from "../chatIcons";
import { accessModesFor, planSupported, type ConversationCard } from "../chatModel";
import { messageFor } from "../attachments/send";
import { ChatComposer } from "../ChatComposer";
import { ChatFrame } from "../ChatFrame";
import { ComposerColumn } from "../ComposerColumn";
import { QUEUE_KEY } from "../ConversationView";
import { ActivityLine } from "../LiveActivity";
import { ContextStrip } from "../NewConversation";
import { PermissionCard } from "../permissions/PermissionCard";
import { usePendingAsks } from "../permissions/permissionsStore";
import { queueOrSend } from "../queueRunner";
import { useChatStore } from "../store";
import { TeamMentionMenu, useTeamComposer } from "../team/TeamComposer";
import { TeamThreadFeed } from "../team/TeamThreadFeed";
import { TimelineView, type ApprovalNote } from "../timeline/ConversationTimeline";
import { addPending, dropPending, usePending } from "../timeline/pending";
import { withDrafts } from "../timeline/streaming";
import type { RequestRow, ThreadRow } from "./ipc";
import { EMPTY_LIVE, isPlanExit, menuAccess, questionOf, togglePlan } from "./model";
import { answerRequest, hydrateThread, interruptThread, retuneThread, sendToThread, useStructured } from "./store";

/**
 * Uma conversa por protocolo (o Codex pelo `app-server`, o Claude Code pelo `claude -p`): a mesma
 * timeline e o mesmo composer das outras, mas sem terminal. Aprovações e perguntas chegam como
 * pedidos do agente e se respondem aqui; parar interrompe o turno; modelo, esforço e acesso valem a
 * partir do próximo turno. No Claude, o Plano liga e desliga aqui, e sair dele é um pedido do agente
 * (aprovar o plano).
 */
export function StructuredConversationView({ card, thread, cards = [] }: { card: ConversationCard; thread: ThreadRow; cards?: ConversationCard[] }) {
  const { t } = useTranslation();
  // Orquestrador de um time: "Time | Só o orquestrador", o @agente e o resumo do time (prancheta 15).
  const team = useTeamComposer(card, cards);
  const live = useStructured((s) => s.live[thread.id]) ?? EMPTY_LIVE;
  const agentInfo = useTabsStore((s) => s.detectedAgents.find((a) => a.id === thread.agentId))
    ?? { id: thread.agentId, label: card.agentLabel, command: "", available: true };
  const hydrated = useStructured((s) => !!s.hydrated[thread.id]);
  useEffect(() => hydrateThread(thread.id), [thread.id]);

  const request: RequestRow | null = live.requests[0] ?? null;
  const working = live.phase === "working";
  // O pedido de permissão vira o cartão do fio (prancheta 14); perguntas e a saída do Plano seguem no composer.
  const asks = usePendingAsks();
  const ask = useMemo(() => (request ? asks.find((a) => a.ref.source === "thread" && a.ref.requestId === request.id) ?? null : null), [asks, request]);
  const key = `thread:${thread.id}`;
  const queued = useChatStore((s) => s.queues[key]?.length ?? 0);
  // O texto chegando entra na timeline como item (o mesmo id do item final), e o raciocínio
  // chegando alimenta a linha viva.
  const items = useMemo(() => withDrafts(live.items, live.drafts), [live.items, live.drafts]);
  // Com o agente trabalhando, a mensagem na fila dele só entra no fio quando o turno dela começa: o envio otimista espera.
  const pending = usePending(key, items, working);
  const streaming = useMemo(() => new Set(live.drafts.map((d) => d.itemId)), [live.drafts]);
  const turn = useMemo(() => turnLive(items, !!request), [items, request]);
  const locked = working || !!request;
  const question = questionOf(request);
  const planExit = isPlanExit(request);
  const plan = thread.access === "plan";
  const note: ApprovalNote | null = request
    ? {
      title: request.kind === "question" ? request.title
        : planExit ? t("chat.structured.planReady")
        : request.title || t(request.kind === "command" ? "chat.structured.command" : "chat.structured.fileChange"),
      detail: request.detail || null,
    }
    : null;
  // «Reenviar» uma mensagem que saiu da fila do agente sem ser enviada.
  const resend = (text: string) => {
    const mark = addPending(key, text, items);
    sendToThread(thread.id, text, () => dropPending(key, mark));
  };
  const answer = (choice: string) => { if (request) answerRequest(thread.id, request.id, choice); };

  const controls = request && !ask ? (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {question ? question.options.map((o) => <ApprovalButton key={o} onClick={() => answer(o)}>{o}</ApprovalButton>) : planExit ? (
        <>
          <ApprovalButton onClick={() => answer("deny")}>{t("chat.structured.planKeep")}</ApprovalButton>
          <ApprovalButton onClick={() => answer("allowSession")}>{t("chat.structured.planEdits")}</ApprovalButton>
          <ApprovalButton primary onClick={() => answer("allow")}>{t("chat.structured.planApprove")}</ApprovalButton>
        </>
      ) : (
        <>
          <ApprovalButton onClick={() => answer("deny")}>{t("chat.approval.deny")}</ApprovalButton>
          <ApprovalButton onClick={() => answer("allowSession")}>{t("chat.approval.session")}</ApprovalButton>
          <ApprovalButton primary onClick={() => answer("allow")}>{t("chat.approval.allow")}</ApprovalButton>
        </>
      )}
    </div>
  ) : (
    <div title={locked ? t("chat.composer.lockedWhileWorking") : undefined} className="flex min-w-0 flex-wrap items-center justify-end gap-x-0.5 gap-y-1">
      <AgentModelPicker agents={[agentInfo]} showAccount={false} disabled={locked}
        value={{ agentId: thread.agentId, model: thread.model, effort: thread.effort, account: null }}
        onChange={(v) => retuneThread(thread.id, v.model, thread.effort, thread.access)} />
      <EffortMenu agentId={thread.agentId} model={thread.model} account={null} value={thread.effort} disabled={locked}
        onChange={(effort) => retuneThread(thread.id, thread.model, effort, thread.access)} />
      {planSupported(thread.agentId, true) && (
        <button type="button" disabled={locked} aria-pressed={plan} onClick={() => retuneThread(thread.id, thread.model, thread.effort, togglePlan(thread.access))}
          title={plan ? t("chat.plan.onHint") : t("chat.plan.offHint")}
          className="flex items-center gap-1.5 h-7 px-2 rounded-lg text-chat-ui font-medium text-gray-900/85 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-50 disabled:hover:bg-transparent">
          <BotIcon className="w-4 h-4 text-gray-500 dark:text-white/45" />
          {plan ? t("chat.plan.plan") : t("chat.plan.build")}
        </button>
      )}
    </div>
  );

  const composer = (
      <ComposerColumn>
        {(live.error ?? team?.error) && <p role="alert" className="mb-2 px-1 text-chat-note text-red-600 dark:text-red-400 break-words">{live.error ?? team?.error}</p>}
        {working && !request && <ActivityLine live={turn} startedAt={null} />}
        <ChatComposer cwd={thread.cwd}
          placeholder={question ? t("chat.structured.answer") : request ? t("chat.composer.redirect") : working ? t("chat.composer.queueHint", { key: QUEUE_KEY }) : team?.placeholder ?? t("chat.composer.reply")}
          onSubmit={(text, attachments) => {
            if (question) { answer(text); return; }
            const prepared = team && text.trim() ? team.prepare(text, { key, items }, attachments) : { text, onSent: () => undefined };
            if (prepared === null) return;
            // O caminho de cada anexo vai no texto (bloco `[Anexos]`) e as imagens também em linha, onde o motor aceita.
            const sent = messageFor(key, prepared.text, attachments);
            // A mensagem aparece na hora; se o backend recusar, sai do fio e o erro aparece no aviso.
            const mark = sent.text.trim() ? addPending(key, sent.text.trim(), items) : null;
            sendToThread(thread.id, sent.text, mark ? () => dropPending(key, mark) : undefined, prepared.onSent, sent.images);
          }}
          onQueue={question ? null : (text, attachments) => {
            const prepared = team ? team.prepare(text, { key, items }, attachments) : { text, onSent: () => undefined };
            // A fila do composer não avisa quando a mensagem sai: o resumo do time conta como entregue ao enfileirar.
            if (prepared !== null) { queueOrSend(key, messageFor(key, prepared.text, attachments).text); prepared.onSent(); }
          }} queued={queued}
          leading={question ? null : team?.controls}
          addon={team && !question ? (ctx) => <TeamMentionMenu conversation={card} cards={cards} {...ctx} /> : undefined}
          onStop={working && !request ? () => interruptThread(thread.id) : null}
          controls={controls} />
        <ContextStrip branch={card.branch} worktree={card.isWorktree}>
          <AccessMenu value={menuAccess(thread.access)} available={accessModesFor(thread.agentId, true)}
            onChange={locked ? undefined : (next) => retuneThread(thread.id, thread.model, thread.effort, next)} />
        </ContextStrip>
      </ComposerColumn>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ChatFrame composer={composer} list={(bottomInset) => (
        <TimelineView bottomInset={bottomInset} items={items} loaded={hydrated} working={working || !!request} live
          approval={note} approvalCard={ask ? <PermissionCard ask={ask} terminal={false} /> : null}
          streaming={streaming} agentLabel={card.agentLabel} agentId={thread.agentId} pending={pending}
          onAnswer={question ? answer : undefined} onResend={resend}
          after={<TeamThreadFeed conversation={card} cards={cards} />} />
      )} />
    </div>
  );
}

function ApprovalButton({ primary = false, onClick, children }: { primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`h-6 px-2 rounded-md text-chat-caption font-medium
        ${primary ? "bg-accent-600 text-white hover:bg-accent-700" : "border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] text-gray-800 dark:text-white/80 hover:bg-gray-50 dark:hover:bg-white/[0.08]"}`}>
      {children}
    </button>
  );
}
