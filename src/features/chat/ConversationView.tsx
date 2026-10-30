import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { readTuning } from "@/features/canvas/tabTuning";
import { useTabsStore } from "@/features/tabs/store";
import { sendKeysToTab } from "@/features/terminal/terminalRegistry";

import { AccessMenu } from "./AccessMenu";
import { turnLive } from "./activityModel";
import { AgentModelPicker, EffortMenu } from "./AgentModelPicker";
import { retuneConversationTab, sendToConversation } from "./chatActions";
import { BotIcon } from "./chatIcons";
import { accessModesFor, planSupported, readAccess, type ChatAccess, type ConversationCard } from "./chatModel";
import { ChatComposer } from "./ChatComposer";
import { useChatWidthClass } from "./chatLook";
import { ActivityLine } from "./LiveActivity";
import { useChatLive } from "./liveStore";
import { ContextStrip } from "./NewConversation";
import { PermissionCard } from "./permissions/PermissionCard";
import { usePendingAsks } from "./permissions/permissionsStore";
import { queueOrSend } from "./queueRunner";
import { setChatSlot, setTerminalOpen, useChatStore } from "./store";
import { TeamMentionMenu, useTeamComposer } from "./team/TeamComposer";
import { TeamThreadFeed } from "./team/TeamThreadFeed";
import { TimelineView } from "./timeline/ConversationTimeline";
import { addPending, usePending } from "./timeline/pending";
import { useConversationTimeline } from "./timeline/useConversationTimeline";

/** A tecla da fila como a pessoa a digita (⌘⏎ no macOS). */
export const QUEUE_KEY = DESKTOP_OS === "macos" ? "⌘⏎" : "Ctrl+⏎";

/** O contêiner contra o qual o retângulo é medido: a casca do chat cobre a mesma área que as abas. */
export const CHAT_SHELL_ATTR = "data-chat-shell";

/** Os agentes cuja conversa vira timeline (o canal lê o transcript deles; ver `canal::supported`). */
const TIMELINE_AGENTS = new Set(["claude-code", "codex"]);

/** A altura da gaveta do terminal (a padrão do T3 Code). */
const DRAWER_H = 280;

export function hasTimeline(agentId: string): boolean {
  return TIMELINE_AGENTS.has(agentId);
}

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
  const timeline = hasTimeline(card.agentId);
  const terminalOpen = useTerminalOpen(card);
  const slotRef = useRef<HTMLDivElement>(null);
  const command = useTabsStore((s) => s.tabs.find((tab) => tab.id === card.tabId)?.command ?? "");
  const agentInfo = useTabsStore((s) => s.detectedAgents.find((a) => a.id === card.agentId))
    ?? { id: card.agentId, label: card.agentLabel, command: "", available: true };
  const tuning = useMemo(() => readTuning(card.agentId, command), [card.agentId, command]);
  const access = useMemo(() => readAccess(card.agentId, command), [card.agentId, command]);
  const working = useChatLive((s) => s.phase[card.tabId] === "working");
  const turnStart = useChatLive((s) => s.turn[card.tabId]?.startedAt ?? null);
  const width = useChatWidthClass();
  // O pedido da TUI vem do store único das permissões (o `PermissionsManager` lê a tela).
  const asks = usePendingAsks();
  const approval = useMemo(() => asks.find((a) => a.conversation === card.tabId) ?? null, [asks, card.tabId]);
  const queued = useChatStore((s) => s.queues[card.tabId]?.length ?? 0);
  const { timeline: read, loaded, phase } = useConversationTimeline(card.tabId);
  const items = useMemo(() => read?.items ?? [], [read]);
  const live = useMemo(() => turnLive(items, !!approval), [items, approval]);
  // O que a pessoa acabou de enviar aparece já, até o transcript devolver a mensagem.
  const pending = usePending(card.tabId, items);
  const busy = working || phase === "working";
  // Orquestrador de um time: "Time | Só o orquestrador", o @agente e o resumo do time (prancheta 15).
  const team = useTeamComposer(card, cards);
  // Trocar reinicia o agente (retomando a sessão): nunca no meio de um turno.
  const locked = busy || !!approval;
  const retune = (patch: Partial<{ model: string | null; effort: string | null; access: ChatAccess; plan: boolean }>) =>
    retuneConversationTab(card.tabId, {
      model: patch.model !== undefined ? patch.model : tuning.model,
      effort: patch.effort !== undefined ? patch.effort : tuning.effort,
      access: patch.access ?? access.access,
      plan: patch.plan ?? access.plan,
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
    <div title={locked ? t("chat.composer.lockedWhileWorking") : t("chat.composer.retuneHint")} className="flex items-center gap-0.5">
      <AgentModelPicker agents={[agentInfo]} showAccount={false} disabled={locked}
        value={{ agentId: card.agentId, model: tuning.model, effort: tuning.effort, account: null }}
        onChange={(v) => retune({ model: v.model })} />
      <EffortMenu agentId={card.agentId} model={tuning.model} account={null} value={tuning.effort} disabled={locked}
        onChange={(effort) => retune({ effort })} />
      {planSupported(card.agentId) && (
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
    <div className={`w-full ${width} mx-auto px-4 sm:px-12 pb-3`}>
      {busy && !approval && <ActivityLine live={live} startedAt={turnStart} />}
      <ChatComposer cwd={card.cwd}
        placeholder={approval ? t("chat.composer.redirect") : busy ? t("chat.composer.queueHint", { key: QUEUE_KEY }) : team?.placeholder ?? t("chat.composer.reply")}
        onSubmit={(text) => {
          const out = team ? team.prepare(text) : text;
          if (out === null) return;
          if (timeline && out.trim()) addPending(card.tabId, out.trim(), items);
          sendToConversation(card.tabId, out);
        }}
        onQueue={(text) => { const out = team ? team.prepare(text) : text; if (out !== null) queueOrSend(card.tabId, out); }} queued={queued}
        onStop={busy && !approval ? () => sendKeysToTab(card.tabId, "\u001b") : null}
        leading={team?.controls}
        addon={team ? (ctx) => <TeamMentionMenu conversation={card} cards={cards} {...ctx} /> : undefined}
        controls={controls} />
      <ContextStrip branch={card.branch} worktree={card.isWorktree}>
        <AccessMenu value={access.plan ? "ask" : access.access} available={accessModesFor(card.agentId)}
          onChange={locked ? undefined : (next) => retune({ access: next, plan: false })} />
      </ContextStrip>
    </div>
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
        {approval && <div className={`w-full ${width} mx-auto px-4 sm:px-12 pb-3`}><PermissionCard ask={approval} terminal /></div>}
        {composer}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TimelineView items={items} loaded={loaded} missing={loaded && !read} truncated={!!read?.truncated}
        working={busy || approval !== null} approval={null} live
        approvalCard={approval ? <PermissionCard ask={approval} terminal /> : null}
        agentLabel={card.agentLabel} agentId={card.agentId} pending={pending} onOpenTerminal={() => setTerminalOpen(card.tabId, true)}
        after={<TeamThreadFeed conversation={card} cards={cards} />} />
      {composer}
      {terminalOpen && (
        <section aria-label={t("chat.terminal.label")} style={{ height: DRAWER_H }}
          className="shrink-0 border-t border-gray-200 dark:border-white/[0.08] bg-white dark:bg-black">
          <div ref={slotRef} data-chat-terminal={card.tabId} className="h-full" />
        </section>
      )}
    </div>
  );
}
