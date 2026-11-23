import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationCard } from "../chatModel";
import { ChevronRightIcon, UsersIcon } from "../chatIcons";
import { ChatMessageMarkdown } from "../attachments/ChatMessageMarkdown";
import { renderChatCodeBlock } from "../timeline/CodeBlockFrame";
import { peerMarkdown, peerMessagesOf, type PeerFeedMessage } from "../timeline/peerEnvelope";
import type { TimelineItem } from "../timeline/types";
import { chatTeamHandoff, type TeamFeedItem, type TeamHandoff } from "./ipc";
import { openMember } from "./TeamPanel";
import { cardTime, deliveryMarkdown, deliveryOutcome } from "./deliveryCard";
import { AgentMono, StateDot, useRoleLabel } from "./TeamParts";
import { deliveries, delegationCards, memberState, placeOf, stateTone, teamLedBy, type DelegationCard } from "./teamModel";
import { loadFeed, startTeams, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

const NO_ITEMS: TimelineItem[] = [];
/** A tarefa que o orquestrador deu a este integrante antes da entrega: o texto inteiro, para o cartão. */
function taskBefore(feed: TeamFeedItem[], delivery: TeamFeedItem): string | null {
  let task: string | null = null;
  for (const f of feed) if (f.kind === "delegation" && f.member === delivery.member && f.id < delivery.id) task = f.task;
  return task;
}
const DELIVERY_NUMBER = /^\s*ENTREGA #(\d+)/;

/**
 * No fio do orquestrador: as delegações e entregas do time numa linha só, recolhida ("Time · 3
 * delegações · 2 entregas"). Abre ao clicar; recolhida não lê nada do backend nem ocupa o chat.
 * Vai depois da timeline da conversa.
 */
export function TeamThreadFeed({ conversation, cards, items: timeline = NO_ITEMS }: { conversation: ConversationCard; cards: ConversationCard[]; /** A timeline do orquestrador: dela saem as mensagens entre agentes, que o corpo do chat não mostra. */ items?: TimelineItem[] }) {
  const { t } = useTranslation();
  useEffect(() => startTeams(), []);
  const teams = useTeamStore((s) => s.teams);
  const team = useMemo(() => teamLedBy(teams, conversation.tabId), [teams, conversation.tabId]);
  const feed = useTeamStore((s) => (team ? s.feeds[team.id] : undefined));
  useEffect(() => { if (team) void loadFeed(team.id); }, [team?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useTeamLive(cards);
  const items = useMemo(() => feed ?? [], [feed]);
  const delegations = useMemo(() => delegationCards(items, (ref) => memberState(live.liveOf(ref), items, ref)), [items, live]);
  const delivered = useMemo(() => deliveries(items).filter((d) => d.handoff !== null), [items]);
  // As entregas já têm a linha própria (o Handoff inteiro); o resto das mensagens entre agentes vem da timeline.
  const messages = useMemo(() => {
    const handoffs = new Set(delivered.map((d) => d.handoff));
    return peerMessagesOf(timeline).filter((m) => {
      const n = DELIVERY_NUMBER.exec(m.body);
      return !(n && handoffs.has(Number(n[1])));
    });
  }, [timeline, delivered]);
  const [open, setOpen] = useState(false);
  if (!team || (delegations.length === 0 && delivered.length === 0 && messages.length === 0)) return null;
  // O que ainda pede atenção aparece já na linha recolhida; o resto fica dentro.
  const busy = delegations.filter((d) => d.state === "working" || d.state === "approval" || d.state === "question").length;
  return (
    <section aria-label={t("chat.team.feed.label")} className="flex flex-col text-chat-prose">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-2.5 min-h-[26px] text-left text-chat-ui text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/75">
        <UsersIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
        <span className="min-w-0 truncate">
          {t("chat.team.feed.title")}
          {delegations.length > 0 && <> · {t("chat.team.feed.delegations", { count: delegations.length })}</>}
          {delivered.length > 0 && <> · {t("chat.team.feed.deliveries", { count: delivered.length })}</>}
          {messages.length > 0 && <> · {t("chat.team.feed.messages", { count: messages.length })}</>}
        </span>
        {busy > 0 && <span className={`shrink-0 ${stateTone("working")}`}>● {t("chat.team.feed.busy", { count: busy })}</span>}
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="ml-[26px] mt-1 flex flex-col gap-1">
          {delegations.map((card) => <DelegationRow key={card.id} card={card} teamId={team.id} />)}
          {delivered.map((d) => <DeliveryRow key={d.id} teamId={team.id} id={d.handoff!} at={d.at} name={live.nameOf(d.member) ?? d.memberName} agentId={placeOf(teams, d.member)?.member?.agentId ?? ""} task={taskBefore(items, d)} />)}
          {messages.map((m) => <PeerMessageRow key={m.itemId} message={m} />)}
          <p className="m-0 mt-1 text-chat-caption text-gray-400 dark:text-white/35">{t("chat.team.feed.footer")}</p>
        </div>
      )}
    </section>
  );
}

/**
 * Uma delegação, no desenho do T3 Code para tarefa delegada: ícone do agente, nome · papel, a tarefa numa linha e o
 * estado; clicar abre o texto inteiro da tarefa em Markdown. "Abrir" leva à conversa do integrante.
 */
function DelegationRow({ card, teamId }: { card: DelegationCard; teamId: string }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const [open, setOpen] = useState(false);
  const member = useTeamStore((s) => placeOf(s.teams, card.member)?.member ?? null);
  const name = member?.label ? member.label.split(" · ")[0]! : card.memberName;
  const gist = card.task.replace(/\s+/g, " ").trim();
  return (
    <div data-team={teamId} data-delegation-card className="flex flex-col rounded-md">
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-white/[0.04]">
          <AgentMono agentId={member?.agentId ?? ""} label={name} size={20} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2 text-chat-note">
              <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">{name}</span>
              <span className="shrink-0 whitespace-nowrap text-gray-500 dark:text-white/45">· {roleLabel(member?.role ?? "generalist")}</span>
            </span>
            <span className={`block text-chat-caption text-gray-500 dark:text-white/50 ${open ? "" : "truncate"}`}>{open ? t("chat.team.card.delegated") : gist}</span>
          </span>
          <StateDot state={card.state} className="shrink-0 whitespace-nowrap text-chat-caption" />
          <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <button type="button" onClick={() => openMember(card.member)}
          className="shrink-0 h-7 px-2 rounded-md text-chat-caption text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
          {t("chat.team.open")}
        </button>
      </div>
      {open && (
        <div className="ml-9 mb-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] px-3 py-2 text-chat-note">
          <ChatMessageMarkdown content={peerMarkdown(card.task)} renderCodeBlock={renderChatCodeBlock} />
        </div>
      )}
    </div>
  );
}

/** Uma mensagem de um agente do time ao orquestrador: uma linha com o remetente e o começo; aberta, o Markdown inteiro. */
function PeerMessageRow({ message }: { message: PeerFeedMessage }) {
  const [open, setOpen] = useState(false);
  const gist = message.body.replace(/\s+/g, " ").trim();
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-2 min-h-[26px] text-left text-chat-note hover:bg-gray-50 dark:hover:bg-white/[0.04] rounded-md">
        <span className="shrink-0 font-medium text-gray-900 dark:text-white">{message.sender}</span>
        {!open && <span className="min-w-0 flex-1 truncate text-gray-600 dark:text-white/60">{gist}</span>}
        {open && <span className="flex-1" />}
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="ml-1 mb-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] px-3 py-2 text-chat-note">
          <ChatMessageMarkdown content={peerMarkdown(message.body)} renderCodeBlock={renderChatCodeBlock} />
        </div>
      )}
    </div>
  );
}

/**
 * A entrega que voltou (Handoff v1, lido do backend só quando o grupo abre), no desenho do T3 Code para a conclusão de
 * uma tarefa delegada: ícone do agente, nome, resumo numa linha, estado (Concluída/Bloqueada) e hora. Clicar abre
 * tudo em Markdown (tarefa, resumo, PR, arquivos, testes, riscos, pendências), sem cortar nada.
 */
function DeliveryRow({ teamId, id, at, name, agentId, task }: { teamId: string; id: number; at: number; name: string; agentId: string; task: string | null }) {
  const { t } = useTranslation();
  const [handoff, setHandoff] = useState<TeamHandoff | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    chatTeamHandoff(teamId, id).then((h) => { if (alive) setHandoff(h); }).catch(() => undefined);
    return () => { alive = false; };
  }, [teamId, id]);
  const body = handoff?.handoff;
  const outcome = deliveryOutcome(body);
  const markdown = useMemo(() => (body ? deliveryMarkdown(body, task, t) : ""), [body, task, t]);
  const summary = body?.summary?.replace(/\s+/g, " ").trim();
  return (
    <div data-delivery-card className="flex flex-col rounded-md">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-white/[0.04]">
        <AgentMono agentId={agentId} label={name} size={20} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-chat-note font-medium text-gray-900 dark:text-white">{t("chat.team.feed.delivered", { name, id })}</span>
          <span className="block truncate text-chat-caption text-gray-500 dark:text-white/50">{summary ?? t("chat.team.feed.loading")}</span>
        </span>
        <span className={`shrink-0 text-chat-caption ${outcome === "blocked" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-white/45"}`}>{t(`chat.team.card.${outcome}`)}</span>
        <span className="shrink-0 tabular-nums text-chat-caption text-gray-400 dark:text-white/35">{cardTime(at)}</span>
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && body && (
        <div className="ml-9 mb-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] px-3 py-2 text-chat-note">
          <ChatMessageMarkdown content={markdown} renderCodeBlock={renderChatCodeBlock} />
        </div>
      )}
    </div>
  );
}

/** O selo do cabeçalho: "Orquestrador · Claude Code" (ou o papel, num integrante). */
export function TeamHeaderBadge({ conversation }: { conversation: ConversationCard | null }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const teams = useTeamStore((s) => s.teams);
  const place = useMemo(() => placeOf(teams, conversation?.tabId), [teams, conversation?.tabId]);
  useEffect(() => startTeams(), []);
  if (!conversation || !place) return null;
  const text = place.member
    ? t("chat.team.memberBadge", { role: roleLabel(place.member.role) })
    : t("chat.team.orchestratorBadge", { agent: conversation.agentLabel });
  return (
    <span className="shrink-0 inline-flex items-center h-[22px] px-2 rounded-full bg-gray-100 dark:bg-white/[0.06] text-chat-caption text-gray-600 dark:text-white/60">
      {text}
    </span>
  );
}
