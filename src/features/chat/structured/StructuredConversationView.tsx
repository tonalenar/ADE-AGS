import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";

import { turnLive } from "../activityModel";
import { AgentModelPicker } from "../AgentModelPicker";
import { ThreadAccountMenu } from "./ThreadAccountMenu";
import { BotIcon } from "../chatIcons";
import { accessModesFor, extractSlashCommand, midTurnOf, planSupported, queueHintKey, type ConversationCard } from "../chatModel";
import { goalPauseResumeAvailable, isLegacyGoalClearAlias, matrixProviderForAgent, useHarnessCapability } from "../harnessCapabilities";
import { messageFor } from "../attachments/send";
import { ChatComposer } from "../ChatComposer";
import { newConversationLocal } from "../chatActions";
import { useChatPrefs } from "../chatPrefs";
import { ComposerAssistMenu } from "../ComposerAssistMenu";
import { ChatFrame } from "../ChatFrame";
import { ComposerColumn } from "../ComposerColumn";
import { NO_QUEUE, QUEUE_KEY } from "../ConversationView";
import { ActivityLine } from "../LiveActivity";
import { ContextStrip } from "../NewConversation";
import { PermissionCard } from "../permissions/PermissionCard";
import { usePendingAsks } from "../permissions/permissionsStore";
import { unsnoozeConversation } from "../shelf";
import { queueOrSend, sendNow } from "../queueRunner";
import { clearThreadSearchJump, unqueueMessage, updateQueuedMessage, useChatStore } from "../store";
import { useTeamComposer } from "../team/TeamComposer";
import { TeamThreadFeed } from "../team/TeamThreadFeed";
import { HarnessRunFeed } from "./HarnessRunFeed";
import { TimelineView, type ApprovalNote } from "../timeline/ConversationTimeline";
import { addPending, dropPending, usePending } from "../timeline/pending";
import { withDrafts } from "../timeline/streaming";
import type { RequestRow, ThreadRow } from "./ipc";
import { EMPTY_LIVE, isLocalAcpAgent, isPlanExit, menuAccess, questionOf, togglePlan } from "./model";
import { AgentSwitchDialog } from "./AgentSwitchDialog";
import { answerRequest, autoCompactThreadOnReturn, clearThreadContext, compactThread, hydrateThread, interruptThread, retuneThread, runThreadGoalAction, sendToThread, switchThreadAgent, useStructured } from "./store";
import { lacksApproval, switchableAgents } from "./switchModel";
import { showBotToast } from "@/shared/brand/botToastStore";

/**
 * Uma conversa por protocolo (o Codex pelo `app-server`, o Claude Code pelo `claude -p`): a mesma
 * timeline e o mesmo composer das outras, mas sem terminal. Aprovações e perguntas chegam como
 * pedidos do agente e se respondem aqui; parar interrompe o turno; modelo, esforço e acesso valem a
 * partir do próximo turno. No Claude, o Plano liga e desliga aqui, e sair dele é um pedido do agente
 * (aprovar o plano).
 */
export function StructuredConversationView({ card, thread, cards = [] }: { card: ConversationCard; thread: ThreadRow; cards?: ConversationCard[] }) {
  const { t } = useTranslation();
  const followUpBehavior = useChatPrefs().followUpBehavior;
  // Orquestrador de um time: "Time | Só o orquestrador", o @agente e o resumo do time (prancheta 15).
  const team = useTeamComposer(card, cards);
  const live = useStructured((s) => s.live[thread.id]) ?? EMPTY_LIVE;
  const hydrated = useStructured((s) => !!s.hydrated[thread.id]);
  const goal = useStructured((s) => s.goals[thread.id] ?? null);
  const goalNotice = useStructured((s) => s.goalNotices[thread.id] ?? null);
  // Trocar de agente na mesma conversa: a escolha espera a confirmação (a cada troca).
  const detected = useAvailableAgents({ includeLocalAcp: true });
  const switchable = useMemo(() => switchableAgents(detected, thread.agentId, card.agentLabel), [detected, thread.agentId, card.agentLabel]);
  const [switchTo, setSwitchTo] = useState<{ agentId: string; model: string | null } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  useEffect(() => {
    hydrateThread(thread.id);
  }, [thread.id, thread.agentId]);

  const request: RequestRow | null = live.requests[0] ?? null;
  const working = live.phase === "working";
  // O pedido de permissão vira o cartão do fio (prancheta 14); perguntas e a saída do Plano seguem no composer.
  const asks = usePendingAsks();
  const ask = useMemo(() => (request ? asks.find((a) => a.ref.source === "thread" && a.ref.requestId === request.id) ?? null : null), [asks, request]);
  const key = `thread:${thread.id}`;
  const queue = useChatStore((s) => s.queues[key]) ?? NO_QUEUE;
  const searchTarget = useChatStore((s) => s.threadSearchTarget?.threadId === thread.id ? s.threadSearchTarget : null);
  // O que o ⏎ faz com o agente trabalhando: entra no turno (Codex, Claude) ou para o turno e vai como o próximo.
  const matrixProvider = matrixProviderForAgent(thread.agentId);
  const steerCapability = useHarnessCapability("chat", matrixProvider, "steer");
  const interruptCapability = useHarnessCapability("chat", matrixProvider, "interrupt");
  const compactCapability = useHarnessCapability("chat", matrixProvider, "compact");
  const goalCapability = useHarnessCapability("chat", matrixProvider, "goal");
  const switchApprovalCapability = useHarnessCapability("chat", matrixProviderForAgent(switchTo?.agentId ?? thread.agentId), "approval");
  const midTurn = steerCapability.support === "supported" ? "steer"
    : steerCapability.support === "unsupported" && interruptCapability.support === "supported" ? "interrupt"
      : midTurnOf(thread.agentId);
  useEffect(() => {
    if (!compactCapability.loading && compactCapability.available) autoCompactThreadOnReturn(thread.id);
  }, [thread.id, thread.agentId, compactCapability.loading, compactCapability.available]);
  // O texto chegando entra na timeline como item (o mesmo id do item final), e o raciocínio
  // chegando alimenta a linha viva.
  const items = useMemo(() => withDrafts(live.items, live.drafts), [live.items, live.drafts]);
  const quoteSourceIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const promptHistory = useMemo(() => items.flatMap((item) => item.kind === "user" && item.text?.trim() ? [item.text] : []), [items]);
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
  const handleGoalAction = (action: "show" | "set" | "pause" | "resume" | "clear", objective?: string) => {
    void runThreadGoalAction(thread.id, action, objective);
  };

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
    <div title={locked ? t("chat.composer.lockedWhileWorking") : undefined} className="flex min-w-0 flex-nowrap items-center justify-end gap-x-0.5">
      {/* O trilho de agentes: escolher outro agente troca quem responde NESTA conversa (com confirmação, só entre turnos). */}
      {/* A conta da conversa mora dentro do seletor de agente/modelo (no rodapé do popover), não solta no composer. */}
      <AgentModelPicker agents={switchable} harnessSurface="chat" showAccount={false} disabled={locked} providerConfig={live.providerConfig}
        accountSlot={isLocalAcpAgent(thread.agentId) ? null : <ThreadAccountMenu threadId={thread.id} agentId={thread.agentId} accountId={thread.accountId} disabled={locked} />}
        value={{ agentId: thread.agentId, model: thread.model, effort: thread.effort, account: null }}
        permission={{ value: menuAccess(thread.access), modes: accessModesFor(thread.agentId, true), onChange: locked ? undefined : (next) => retuneThread(thread.id, thread.model, thread.effort, next) }}
        onChange={(v) => {
          if (v.agentId && v.agentId !== thread.agentId) { setSwitchError(null); setSwitchTo({ agentId: v.agentId, model: v.model }); return; }
          retuneThread(thread.id, v.model, v.effort, thread.access);
        }} />
      {planSupported(thread.agentId, true) && (
        <button type="button" disabled={locked} aria-pressed={plan} onClick={() => retuneThread(thread.id, thread.model, thread.effort, togglePlan(thread.access))}
          title={plan ? t("chat.plan.onHint") : t("chat.plan.offHint")}
          className="flex shrink-0 items-center gap-1.5 h-7 px-2 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-900/85 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-50 disabled:hover:bg-transparent">
          <BotIcon className="w-4 h-4 shrink-0 text-gray-500 dark:text-white/45" />
          {/* Coluna estreita: só o ícone; o rótulo segue para o leitor de tela e o tooltip diz o modo. */}
          <span className="@max-[30rem]/composer:sr-only">{plan ? t("chat.plan.plan") : t("chat.plan.build")}</span>
        </button>
      )}
    </div>
  );

  const composer = (
      <ComposerColumn>
        {(goal || goalNotice === "none") && (
          <div className="mb-2 flex min-w-0 items-center gap-2 rounded-lg border border-gray-200/80 dark:border-white/10 bg-gray-50/80 dark:bg-white/[0.03] px-3 py-2 text-chat-caption">
            {goal ? (
              <>
                <span className="shrink-0 font-semibold text-gray-700 dark:text-white/70">{t("chat.goal.label")}</span>
                <span className="min-w-0 flex-1 truncate text-gray-600 dark:text-white/60" title={goal.objective}>{goal.objective}</span>
                <span className="shrink-0 text-gray-400 dark:text-white/40">{t(`chat.goal.status.${goal.status}`)}</span>
                {goalPauseResumeAvailable(matrixProvider) && goal.status === "active" && (
                  <GoalButton disabled={!!request} onClick={() => handleGoalAction("pause")}>{t("chat.goal.pause")}</GoalButton>
                )}
                {goalPauseResumeAvailable(matrixProvider) && goal.status === "paused" && (
                  <GoalButton disabled={working || !!request} onClick={() => handleGoalAction("resume")}>{t("chat.goal.resume")}</GoalButton>
                )}
                <GoalButton disabled={!goalCapability.available || working || !!request} title={!goalCapability.available ? goalCapability.reason ?? undefined : undefined}
                  onClick={() => handleGoalAction("clear")}>{t("chat.goal.clear")}</GoalButton>
              </>
            ) : <span className="text-gray-500 dark:text-white/45">{t("chat.goal.none")}</span>}
          </div>
        )}
        {(live.error ?? team?.error) && <p role="alert" className="mb-2 px-1 text-chat-note text-red-600 dark:text-red-400 break-words">{live.error ?? team?.error}</p>}
        {working && !request && <ActivityLine live={turn} startedAt={null} />}
        <ChatComposer cwd={thread.cwd} quoteKey={card.tabId} quoteThreadId={thread.id} quoteSourceIds={quoteSourceIds} promptHistory={promptHistory}
          turnActive={working} forceSend={!!request}
          placeholder={question ? t("chat.structured.answer") : request ? t("chat.composer.redirect") : working
            ? t(queueHintKey(thread.agentId, followUpBehavior), { key: QUEUE_KEY })
            : team?.placeholder ?? t("chat.composer.reply")}
          onSubmit={async (text, attachments) => {
            if (question) { answer(text); return; }
            const planCommand = extractSlashCommand(text, "plan");
            if (planCommand.found && text.trim().toLowerCase() === "/plan" && attachments.length === 0) {
              if (locked) {
                showBotToast({ title: t("chat.plan.label"), text: t("chat.composer.lockedWhileWorking"), tone: "info", ms: 6000 });
                return false;
              }
              if (!planSupported(thread.agentId, true)) {
                showBotToast({ title: t("chat.plan.label"), text: t("chat.plan.unsupported"), tone: "info", ms: 6000 });
                return false;
              }
              return await retuneThread(thread.id, thread.model, thread.effort, togglePlan(thread.access));
            }
            if (attachments.length === 0 && /^\/clear\s*$/i.test(text.trim())) { void clearThreadContext(thread.id); return; }
            if (attachments.length === 0) {
              const command = /^\/(compact|goal)(?:\s+([\s\S]*))?\s*$/i.exec(text.trim());
              if (command?.[1]?.toLowerCase() === "compact" && compactCapability.available) { void compactThread(thread.id, command[2]?.trim() || undefined); return; }
              if (command?.[1]?.toLowerCase() === "goal" && goalCapability.available) {
                const argument = command[2]?.trim() ?? "";
                if (!argument || /^edit$/i.test(argument)) { handleGoalAction("show"); return; }
                const action = /^(clear|pause|resume)$/i.exec(argument)?.[1]?.toLowerCase();
                if (action === "clear" || action === "pause" || action === "resume") { handleGoalAction(action); return; }
                if (isLegacyGoalClearAlias(matrixProvider, argument)) { handleGoalAction("clear"); return; }
                handleGoalAction("set", argument);
                return;
              }
            }
            const prepared = team && text.trim() ? team.prepare(text, { key, items }, attachments) : { text, onSent: () => undefined };
            if (prepared === null) return;
            // O caminho de cada anexo vai no texto (bloco `[Anexos]`) e as imagens também em linha, onde o motor aceita.
            const sent = messageFor(key, prepared.text, attachments);
            const deliver = () => {
              // A mensagem aparece na hora; se o backend recusar, sai do fio e o erro aparece no aviso.
              const mark = sent.text.trim() ? addPending(key, sent.text.trim(), items) : null;
              sendToThread(thread.id, sent.text, mark ? () => dropPending(key, mark) : undefined, prepared.onSent, sent.images);
            };
            // Com um pedido esperando a pessoa, a mensagem vai como sempre (redireciona o agente).
            if (request) { deliver(); return; }
            // «Enviar agora»: no motor que não aceita entrada no meio do turno, o turno para e ela sai em seguida
            // (aparece acima da caixa até sair). As imagens em linha só existem no Claude, que entra no turno.
            if (sendNow(key, sent.text, midTurn, deliver) === "interrupting") prepared.onSent();
          }}
          onSendAndNewThread={newConversationLocal}
          onQueue={question ? null : (text, attachments) => {
            const planCommand = extractSlashCommand(text, "plan");
            if (planCommand.found && text.trim().toLowerCase() === "/plan" && attachments.length === 0) {
              if (locked) {
                showBotToast({ title: t("chat.plan.label"), text: t("chat.composer.lockedWhileWorking"), tone: "info", ms: 6000 });
                return false;
              }
              if (!planSupported(thread.agentId, true)) {
                showBotToast({ title: t("chat.plan.label"), text: t("chat.plan.unsupported"), tone: "info", ms: 6000 });
                return false;
              }
              void retuneThread(thread.id, thread.model, thread.effort, togglePlan(thread.access));
              return true;
            }
            const prepared = team ? team.prepare(text, { key, items }, attachments) : { text, onSent: () => undefined };
            // A fila do composer não avisa quando a mensagem sai: o resumo do time conta como entregue ao enfileirar.
            if (prepared !== null) {
              const queued = messageFor(key, prepared.text, attachments).text;
              if (queued.trim()) unsnoozeConversation(key);
              queueOrSend(key, queued);
              prepared.onSent();
            }
            return prepared !== null;
          }} queue={queue} onUnqueue={(id) => unqueueMessage(key, id)} onUpdateQueued={(id, text) => updateQueuedMessage(key, id, text)}
          leading={question ? null : team?.controls}
          addon={(context) => <ComposerAssistMenu cwd={thread.cwd} agentId={thread.agentId} conversationKey={key}
            teamOptions={team?.mentions}
            providerCommands={thread.agentId === "opencode" || isLocalAcpAgent(thread.agentId) ? live.providerCommands : []}
            onPlan={!locked && planSupported(thread.agentId, true) ? () => { void retuneThread(thread.id, thread.model, thread.effort, togglePlan(thread.access)); } : undefined}
            context={context} />}
          onStop={working && !request && interruptCapability.available ? () => interruptThread(thread.id) : null}
          stopUnavailableReason={working && !request && !interruptCapability.available ? interruptCapability.reason : null}
          controls={controls} />
        {isLocalAcpAgent(thread.agentId) && <p className="mx-2 mt-2 mb-0 text-[11px] leading-4 text-amber-700 dark:text-amber-300">{t("chat.localAcp.permissionWarning")}</p>}
        <ContextStrip branch={card.branch} worktree={card.isWorktree} />
      </ComposerColumn>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ChatFrame composer={composer} list={(bottomInset) => (
        <TimelineView quoteKey={card.tabId} bottomInset={bottomInset} items={items} loaded={hydrated} working={working || !!request} live
          approval={note} approvalCard={ask ? <PermissionCard ask={ask} terminal={false} /> : null}
          streaming={streaming} agentLabel={card.agentLabel} agentId={thread.agentId} pending={pending} threadId={thread.id}
          conversationKey={key} searchTargetId={searchTarget?.itemId} searchTargetToken={searchTarget?.token} onSearchTargetApplied={clearThreadSearchJump}
          onAnswer={question ? answer : undefined} onResend={resend}
          after={<><TeamThreadFeed conversation={card} cards={cards} /><HarnessRunFeed threadId={thread.id} /></>} />
      )} />
      {switchTo && (
        <AgentSwitchDialog from={card.agentLabel} to={switchable.find((a) => a.id === switchTo.agentId)?.label ?? switchTo.agentId} busy={switching} error={switchError} noApproval={lacksApproval(switchApprovalCapability.support, thread.access, isLocalAcpAgent(switchTo.agentId))}
          onClose={() => setSwitchTo(null)}
          onConfirm={() => {
            setSwitching(true);
            void switchThreadAgent(thread.id, switchTo.agentId, switchTo.model, null, thread.access).then((error) => {
              setSwitching(false);
              if (error) setSwitchError(error);
              else setSwitchTo(null);
            });
          }} />
      )}
    </div>
  );
}

function GoalButton({ disabled, title, onClick, children }: { disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" disabled={disabled} title={title} onClick={onClick}
      className="shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-gray-600 dark:text-white/60 hover:bg-gray-200/70 dark:hover:bg-white/[0.08] disabled:opacity-40">
      {children}
    </button>
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
