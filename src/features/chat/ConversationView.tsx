import { useDisplayPrefs } from "@/features/settings/displayPreferences";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { readTuning } from "@/features/canvas/tabTuning";
import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";
import { sendKeysToTab } from "@/features/terminal/terminalRegistry";

import { turnLive } from "./activityModel";
import { AgentModelPicker } from "./AgentModelPicker";
import { ProjectScriptsMenu } from "./ProjectScriptsMenu";
import { newConversationLocal, retuneConversationTab, sendToConversation, startConversation } from "./chatActions";
import { BotIcon } from "./chatIcons";
import { accessModesFor, extractSlashCommand, fastModeSupported, hasTimeline, readAccess, type ChatAccess, type ConversationCard } from "./chatModel";
import { matrixProviderForAgent, useHarnessCapability } from "./harnessCapabilities";
import { messageFor } from "./attachments/send";
import { ChatComposer } from "./ChatComposer";
import { useChatPrefs } from "./chatPrefs";
import { ComposerAssistMenu } from "./ComposerAssistMenu";
import { ChatFrame } from "./ChatFrame";
import { ComposerColumn } from "./ComposerColumn";
import { ActivityLine } from "./LiveActivity";
import { useChatLive } from "./liveStore";
import { ContextStrip } from "./NewConversation";
import { PermissionCard } from "./permissions/PermissionCard";
import { usePendingAsks } from "./permissions/permissionsStore";
import { unsnoozeConversation } from "./shelf";
import { queueOrSend } from "./queueRunner";
import { clearTabSearchJump, setChatSlot, setTerminalOpen, unqueueMessage, updateQueuedMessage, useChatStore, type QueuedMessage } from "./store";
import { AgentSwitchDialog } from "./structured/AgentSwitchDialog";
import { useTeamComposer } from "./team/TeamComposer";
import { TeamThreadFeed } from "./team/TeamThreadFeed";
import { TimelineView } from "./timeline/ConversationTimeline";
import { addPending, usePending } from "./timeline/pending";
import { buildTuiAgentHandoff } from "./timeline/tuiAgentHandoff";
import { useConversationTimeline } from "./timeline/useConversationTimeline";
import { showBotToast } from "@/shared/brand/botToastStore";

/** A tecla da fila como a pessoa a digita (⌘⏎ no macOS). */
/** A fila vazia, estável (o seletor do store não devolve um array novo a cada render). */
export const NO_QUEUE: QueuedMessage[] = [];

export const QUEUE_KEY = DESKTOP_OS === "macos" ? "⌘⏎" : "Ctrl+⏎";

interface TuiSwitchTarget {
  agent: AgentInfo;
  model: string | null;
  effort: string | null;
  account: string | null;
  handoff: string | null;
}

/** O contêiner contra o qual o retângulo é medido: a casca do chat cobre a mesma área que as abas. */
export const CHAT_SHELL_ATTR = "data-chat-shell";

/** A altura da gaveta do terminal (a padrão do T3 Code). */
const DRAWER_H = 280;

/** A gaveta do terminal está aberta nesta conversa? Sem timeline, o terminal é o corpo: sempre. */
export function useTerminalOpen(card: ConversationCard): boolean {
  const chosen = useChatStore((s) => s.terminalOpen[card.tabId]);
  return !hasTimeline(card.agentId) || (chosen ?? false);
}

/** O retângulo de um elemento relativo à casca do chat (a mesma origem da área de abas). */
function rectIn(el: HTMLElement | null) {
  const base = el?.closest(`[${CHAT_SHELL_ATTR}]`);
  if (!el || !base) return null;
  const r = el.getBoundingClientRect();
  const b = base.getBoundingClientRect();
  return { left: Math.round(r.left - b.left), top: Math.round(r.top - b.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * Uma conversa aberta (prancheta 2). Com Claude Code e Codex o corpo é a timeline lida do transcript
 * e o terminal do agente fica numa gaveta embaixo; nos outros agentes o corpo é o próprio terminal.
 *
 * O terminal nunca é montado aqui: esta tela só reserva o espaço e o publica (`setChatSlot`), e o
 * `TerminalPanel` desenha a TUI ali por cima, sem remontar. Gaveta fechada = nenhum espaço = a TUI
 * continua viva, escondida.
 */
export function ConversationView({ card, cards = [] }: { card: ConversationCard; cards?: ConversationCard[] }) {
  const { t } = useTranslation();
  const followUpBehavior = useChatPrefs().followUpBehavior;
  // "Contexto do composer": a branch e o worktree só ficam abaixo do composer se a preferência pedir.
  const composerContext = useDisplayPrefs().composerContext;
  const planCapability = useHarnessCapability("tui", matrixProviderForAgent(card.agentId), "plan");
  const hasPlan = planCapability.support === "supported";
  const timeline = hasTimeline(card.agentId);
  const terminalOpen = useTerminalOpen(card);
  const slotRef = useRef<HTMLDivElement>(null);
  const command = useTabsStore((s) => s.tabs.find((tab) => tab.id === card.tabId)?.command ?? "");
  const detectedAgents = useTabsStore((s) => s.detectedAgents);
  const agentInfo = useTabsStore((s) => s.detectedAgents.find((a) => a.id === card.agentId))
    ?? { id: card.agentId, label: card.agentLabel, command: "", available: true };
  const switchableAgents = useMemo(() => {
    const available = detectedAgents.filter((candidate) => candidate.available && candidate.id !== "bash");
    const current = available.find((candidate) => candidate.id === card.agentId) ?? agentInfo;
    return [current, ...available.filter((candidate) => candidate.id !== card.agentId)];
  }, [detectedAgents, card.agentId, agentInfo]);
  const tuning = useMemo(() => readTuning(card.agentId, command), [card.agentId, command]);
  const access = useMemo(() => readAccess(card.agentId, command), [card.agentId, command]);
  const working = useChatLive((s) => s.phase[card.tabId] === "working");
  const turnStart = useChatLive((s) => s.turn[card.tabId]?.startedAt ?? null);
  // O pedido da TUI vem do store único das permissões (o `PermissionsManager` lê a tela).
  const asks = usePendingAsks();
  const approval = useMemo(() => asks.find((a) => a.conversation === card.tabId) ?? null, [asks, card.tabId]);
  const queue = useChatStore((s) => s.queues[card.tabId]) ?? NO_QUEUE;
  const { timeline: read, loaded, phase } = useConversationTimeline(card.tabId);
  const items = useMemo(() => read?.items ?? [], [read]);
  const quoteSourceIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const promptHistory = useMemo(() => items.flatMap((item) => item.kind === "user" && item.text?.trim() ? [item.text] : []), [items]);
  const live = useMemo(() => turnLive(items, !!approval), [items, approval]);
  // O que a pessoa acabou de enviar aparece já, até o transcript devolver a mensagem.
  const pending = usePending(card.tabId, items);
  const searchTarget = useChatStore((s) => s.tabSearchTarget?.tabId === card.tabId ? s.tabSearchTarget : null);
  const busy = working || phase === "working";
  const [switchTo, setSwitchTo] = useState<TuiSwitchTarget | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchPlanCapability = useHarnessCapability("tui", matrixProviderForAgent(switchTo?.agent.id ?? card.agentId), "plan");
  // Orquestrador de um time: "Time | Só o orquestrador", o @agente e o resumo do time (prancheta 15).
  const team = useTeamComposer(card, cards);
  // Trocar reinicia o agente (retomando a sessão): nunca no meio de um turno.
  const locked = busy || !!approval;
  const retune = (patch: Partial<{ model: string | null; effort: string | null; access: ChatAccess; plan: boolean; fastMode: boolean }>) =>
    retuneConversationTab(card.tabId, {
      model: patch.model !== undefined ? patch.model : tuning.model,
      effort: patch.effort !== undefined ? patch.effort : tuning.effort,
      access: patch.access ?? access.access,
      plan: patch.plan ?? access.plan,
      fastMode: patch.fastMode ?? tuning.fast,
    });

  const measure = useCallback(() => setChatSlot(rectIn(slotRef.current)), []);
  useLayoutEffect(() => measure());
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const base = el.closest(`[${CHAT_SHELL_ATTR}]`);
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    if (base) observer.observe(base);
    return () => observer.disconnect();
  }, [measure, terminalOpen]);
  // Sem esta tela na frente, nenhum terminal: a de conversa nova não tem onde mostrar um.
  useEffect(() => () => setChatSlot(null), []);

  const controls = (
    <div title={locked ? t("chat.composer.lockedWhileWorking") : t("chat.composer.retuneHint")} className="flex min-w-0 flex-wrap items-center justify-end gap-x-0.5 gap-y-1">
      <AgentModelPicker agents={switchableAgents} showAccount={false} disabled={locked}
        value={{ agentId: card.agentId, model: tuning.model, effort: tuning.effort, account: null }}
        permission={{ value: access.plan ? "ask" : access.access, modes: accessModesFor(card.agentId), onChange: locked ? undefined : (next) => retune({ access: next, plan: false }) }}
        speed={fastModeSupported(card.agentId) ? { fast: tuning.fast, onChange: (fastMode) => retune({ fastMode }) } : undefined}
        onChange={(v) => {
          if (v.agentId && v.agentId !== card.agentId) {
            const target = switchableAgents.find((candidate) => candidate.id === v.agentId);
            if (!target) return;
            setSwitchError(null);
            setSwitchTo({
              agent: target,
              model: v.model,
              effort: v.effort,
              account: v.account,
              handoff: timeline ? buildTuiAgentHandoff(items, card.agentLabel, target.label) : null,
            });
            return;
          }
          retune({ model: v.model, effort: v.effort });
        }} />
      {hasPlan && (
        <button type="button" disabled={locked} onClick={() => retune({ plan: !access.plan })} aria-pressed={access.plan}
          title={access.plan ? t("chat.plan.onHint") : t("chat.plan.offHint")}
          className="flex items-center gap-1.5 h-7 px-2 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-900/85 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-50">
          <BotIcon className="w-4 h-4 text-gray-500 dark:text-white/45" />
          {access.plan ? t("chat.plan.plan") : t("chat.plan.build")}
        </button>
      )}
    </div>
  );

  const composer = (
    <ComposerColumn>
      {team?.error && <p role="alert" className="mb-2 px-1 text-chat-note text-red-600 dark:text-red-400 break-words">{team.error}</p>}
      {busy && !approval && <ActivityLine live={live} startedAt={turnStart} />}
      <ChatComposer cwd={card.cwd} quoteKey={card.tabId} quoteSourceIds={quoteSourceIds} promptHistory={promptHistory}
        turnActive={busy} forceSend={!!approval}
        placeholder={approval ? t("chat.composer.redirect") : busy ? t(followUpBehavior === "queue" ? "chat.composer.queueHintQueue" : "chat.composer.queueHint", { key: QUEUE_KEY }) : team?.placeholder ?? t("chat.composer.reply")}
        onSubmit={(text, attachments) => {
          const planCommand = extractSlashCommand(text, "plan");
          if (planCommand.found && text.trim().toLowerCase() === "/plan" && attachments.length === 0) {
            if (locked) {
              showBotToast({ title: t("chat.plan.label"), text: t("chat.composer.lockedWhileWorking"), tone: "info", ms: 6000 });
              return false;
            }
            if (!hasPlan) {
              showBotToast({ title: t("chat.plan.label"), text: t("chat.plan.unsupported"), tone: "info", ms: 6000 });
              return false;
            }
            retune({ plan: !access.plan });
            return;
          }
          const prepared = team && text.trim() ? team.prepare(text, { key: card.tabId, items }, attachments) : { text, onSent: () => undefined };
          if (prepared === null) return;
          // Os anexos vão como `@caminho` no fim do texto (a TUI os lê pelo caminho).
          const sent = messageFor(card.tabId, prepared.text, attachments).text;
          if (sent.trim()) unsnoozeConversation(card.tabId);
          if (timeline && sent.trim()) addPending(card.tabId, sent.trim(), items);
          sendToConversation(card.tabId, sent);
          // Numa aba não há resposta do backend a esperar: o resumo do time conta como entregue ao enviar.
          prepared.onSent();
        }}
        onSendAndNewThread={newConversationLocal}
        onQueue={(text, attachments) => {
          const planCommand = extractSlashCommand(text, "plan");
          if (planCommand.found && text.trim().toLowerCase() === "/plan" && attachments.length === 0) {
            if (locked) {
              showBotToast({ title: t("chat.plan.label"), text: t("chat.composer.lockedWhileWorking"), tone: "info", ms: 6000 });
              return false;
            }
            if (!hasPlan) {
              showBotToast({ title: t("chat.plan.label"), text: t("chat.plan.unsupported"), tone: "info", ms: 6000 });
              return false;
            }
            retune({ plan: !access.plan });
            return true;
          }
          const prepared = team ? team.prepare(text, { key: card.tabId, items }, attachments) : { text, onSent: () => undefined };
          if (prepared !== null) {
            const queued = messageFor(card.tabId, prepared.text, attachments).text;
            if (queued.trim()) unsnoozeConversation(card.tabId);
            queueOrSend(card.tabId, queued);
            prepared.onSent();
          }
          return prepared !== null;
        }} queue={queue} onUnqueue={(id) => unqueueMessage(card.tabId, id)} onUpdateQueued={(id, text) => updateQueuedMessage(card.tabId, id, text)}
        onStop={busy && !approval ? () => sendKeysToTab(card.tabId, "\u001b") : null}
        leading={team?.controls}
        addon={(context) => <ComposerAssistMenu cwd={card.cwd} agentId={card.agentId} conversationKey={card.tabId}
          teamOptions={team?.mentions} onPlan={!locked && hasPlan ? () => retune({ plan: !access.plan }) : undefined}
          context={context} />}
        controls={controls} />
      <ContextStrip branch={card.branch} worktree={card.isWorktree} showContext={composerContext}>
        <ProjectScriptsMenu key={card.tabId} cwd={card.cwd} owner={{
          kind: card.tabId.startsWith("thread:") ? "thread" : "tab",
          id: card.tabId,
          label: card.agentLabel,
        }} />
      </ContextStrip>
    </ComposerColumn>
  );

  const switchDialog = switchTo && (
    <AgentSwitchDialog from={card.agentLabel} to={switchTo.agent.label} busy={switching} error={switchError}
      mode="newTui" hasContext={!!switchTo.handoff}
      onClose={() => setSwitchTo(null)}
      onConfirm={() => {
        setSwitching(true);
        const targetAccess = accessModesFor(switchTo.agent.id).includes(access.access) ? access.access : "ask";
        void startConversation({
          cwd: card.cwd,
          agent: switchTo.agent,
          prompt: switchTo.handoff ?? "",
          title: card.title,
          account: switchTo.account ?? undefined,
          model: switchTo.model,
          effort: switchTo.effort,
          access: targetAccess,
          plan: access.plan && switchPlanCapability.support === "supported",
          fastMode: false,
        }).catch((error: unknown) => {
          setSwitchError(String(error));
          setSwitching(false);
        });
      }} />
  );

  if (!timeline) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 px-4 sm:px-6 pb-3">
          <div ref={slotRef} data-chat-terminal={card.tabId}
            className="relative h-full mx-auto max-w-[1040px] rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-100 dark:bg-surface">
            {card.starting && (
              <p className="absolute inset-0 flex items-center justify-center text-chat-note text-gray-400 dark:text-white/40">
                {t("chat.conversation.starting", { agent: card.agentLabel })}
              </p>
            )}
          </div>
        </div>
        {/* Sem timeline, o pedido fica logo acima do composer (o terminal mostra o mesmo diálogo). */}
        {approval && <ComposerColumn><PermissionCard ask={approval} terminal /></ComposerColumn>}
        {composer}
        {switchDialog}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
    <ChatFrame composer={composer} list={(bottomInset) => (
      <TimelineView quoteKey={card.tabId} bottomInset={bottomInset} items={items} loaded={loaded} missing={loaded && !read} truncated={!!read?.truncated}
        working={busy || approval !== null} approval={null} live
        approvalCard={approval ? <PermissionCard ask={approval} terminal /> : null}
        agentLabel={card.agentLabel} agentId={card.agentId} pending={pending} onOpenTerminal={() => setTerminalOpen(card.tabId, true)}
        conversationKey={`tab:${card.tabId}`} searchTargetId={searchTarget?.itemId} searchTargetToken={searchTarget?.token} onSearchTargetApplied={clearTabSearchJump}
        after={<TeamThreadFeed conversation={card} cards={cards} />} />
    )} />
      {terminalOpen && (
        <section aria-label={t("chat.terminal.label")} style={{ height: DRAWER_H }}
          className="shrink-0 border-t border-gray-200 dark:border-white/[0.08] bg-white dark:bg-black">
          <div ref={slotRef} data-chat-terminal={card.tabId} className="h-full" />
        </section>
      )}
      {switchDialog}
    </div>
  );
}
