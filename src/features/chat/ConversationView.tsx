import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { readTuning } from "@/features/canvas/tabTuning";
import { answerTerminalPrompt, useTerminalPrompts } from "@/features/canvas/useTerminalPrompts";
import type { PermissionPrompt } from "@/features/canvas/terminalPrompts";
import { useTabsStore } from "@/features/tabs/store";
import { sendKeysToTab } from "@/features/terminal/terminalRegistry";

import { AccessMenu } from "./AccessMenu";
import { AgentModelPicker, EffortMenu } from "./AgentModelPicker";
import { retuneConversationTab, sendToConversation } from "./chatActions";
import { BotIcon } from "./chatIcons";
import { accessModesFor, planSupported, readAccess, type ChatAccess, type ConversationCard } from "./chatModel";
import { ChatComposer } from "./ChatComposer";
import { useChatLive } from "./liveStore";
import { ContextStrip } from "./NewConversation";
import { setChatSlot, setTerminalOpen, useChatStore } from "./store";
import { ConversationTimeline } from "./timeline/ConversationTimeline";

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
export function ConversationView({ card }: { card: ConversationCard }) {
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
  const prompts = useTerminalPrompts(useMemo(() => [{ id: card.tabId, name: card.title }], [card.tabId, card.title]), true);
  const approval: PermissionPrompt | null = prompts[0]?.prompt ?? null;
  // Trocar reinicia o agente (retomando a sessão): nunca no meio de um turno.
  const locked = working || !!approval;
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

  const answer = (id: "allow" | "allowSession" | "deny") => {
    const choice = approval?.choices.find((c) => c.id === id);
    if (choice) answerTerminalPrompt(card.tabId, choice);
  };

  const controls = approval ? (
    <div className="flex items-center gap-1.5">
      {approval.choices.some((c) => c.id === "deny") && (
        <ApprovalButton onClick={() => answer("deny")}>{t("chat.approval.deny")}</ApprovalButton>
      )}
      {approval.choices.some((c) => c.id === "allowSession") && (
        <ApprovalButton onClick={() => answer("allowSession")}>{t("chat.approval.session")}</ApprovalButton>
      )}
      <ApprovalButton primary onClick={() => answer("allow")}>{t("chat.approval.allow")}</ApprovalButton>
    </div>
  ) : (
    <div title={locked ? t("chat.composer.lockedWhileWorking") : t("chat.composer.retuneHint")} className="flex items-center gap-0.5">
      <AgentModelPicker agents={[agentInfo]} showAccount={false} disabled={locked}
        value={{ agentId: card.agentId, model: tuning.model, effort: tuning.effort, account: null }}
        onChange={(v) => retune({ model: v.model })} />
      <EffortMenu agentId={card.agentId} model={tuning.model} account={null} value={tuning.effort} disabled={locked}
        onChange={(effort) => retune({ effort })} />
      {planSupported(card.agentId) && (
        <button type="button" disabled={locked} onClick={() => retune({ plan: !access.plan })} aria-pressed={access.plan}
          title={access.plan ? t("chat.plan.onHint") : t("chat.plan.offHint")}
          className="flex items-center gap-1.5 h-7 px-2 rounded-lg text-[14px] font-medium text-gray-900/85 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-50">
          <BotIcon className="w-4 h-4 text-gray-500 dark:text-white/45" />
          {access.plan ? t("chat.plan.plan") : t("chat.plan.build")}
        </button>
      )}
    </div>
  );

  const composer = (
    <div className="w-full max-w-[736px] mx-auto px-4 sm:px-12 pb-3">
      <ChatComposer cwd={card.cwd}
        placeholder={approval ? t("chat.composer.redirect") : t("chat.composer.reply")}
        onSubmit={(text) => { sendToConversation(card.tabId, text); }}
        onStop={working && !approval ? () => sendKeysToTab(card.tabId, "\u001b") : null}
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
              <p className="absolute inset-0 flex items-center justify-center text-[13px] text-gray-400 dark:text-white/40">
                {t("chat.conversation.starting", { agent: card.agentLabel })}
              </p>
            )}
          </div>
        </div>
        {composer}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ConversationTimeline tabId={card.tabId} agentLabel={card.agentLabel} approval={approval}
        onOpenTerminal={() => setTerminalOpen(card.tabId, true)} />
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

function ApprovalButton({ primary = false, onClick, children }: { primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`h-6 px-2 rounded-md text-[12px] font-medium
        ${primary ? "bg-accent-600 text-white hover:bg-accent-700" : "border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] text-gray-800 dark:text-white/80 hover:bg-gray-50 dark:hover:bg-white/[0.08]"}`}>
      {children}
    </button>
  );
}
