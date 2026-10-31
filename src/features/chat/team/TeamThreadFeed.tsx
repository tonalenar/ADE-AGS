import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationCard } from "../chatModel";
import { ChevronRightIcon, UsersIcon } from "../chatIcons";
import { chatTeamHandoff, type TeamHandoff } from "./ipc";
import { openMember } from "./TeamPanel";
import { AgentMono, StateDot, useRoleLabel } from "./TeamParts";
import { deliveries, delegationCards, memberState, placeOf, stateTone, teamLedBy, type DelegationCard } from "./teamModel";
import { loadFeed, startTeams, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

/**
 * No fio do orquestrador: as delegações e entregas do time numa linha só, recolhida ("Time · 3
 * delegações · 2 entregas"). Abre ao clicar; recolhida não lê nada do backend nem ocupa o chat.
 * Vai depois da timeline da conversa.
 */
export function TeamThreadFeed({ conversation, cards }: { conversation: ConversationCard; cards: ConversationCard[] }) {
  const { t } = useTranslation();
  useEffect(() => startTeams(), []);
  const team = useTeamStore((s) => teamLedBy(s.teams, conversation.tabId));
  const feed = useTeamStore((s) => (team ? s.feeds[team.id] : undefined));
  useEffect(() => { if (team) void loadFeed(team.id); }, [team?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useTeamLive(cards);
  const items = useMemo(() => feed ?? [], [feed]);
  const delegations = useMemo(() => delegationCards(items, (ref) => memberState(live.liveOf(ref), items, ref)), [items, live]);
  const delivered = useMemo(() => deliveries(items).filter((d) => d.handoff !== null), [items]);
  const [open, setOpen] = useState(false);
  if (!team || (delegations.length === 0 && delivered.length === 0)) return null;
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
        </span>
        {busy > 0 && <span className={`shrink-0 ${stateTone("working")}`}>● {t("chat.team.feed.busy", { count: busy })}</span>}
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="ml-[26px] mt-1 flex flex-col gap-1">
          {delegations.map((card) => <DelegationRow key={card.id} card={card} teamId={team.id} />)}
          {delivered.map((d) => <DeliveryRow key={d.id} teamId={team.id} id={d.handoff!} name={live.nameOf(d.member) ?? d.memberName} />)}
          <p className="m-0 mt-1 text-chat-caption text-gray-400 dark:text-white/35">{t("chat.team.feed.footer")}</p>
        </div>
      )}
    </section>
  );
}

/** Uma delegação numa linha: agente · papel · tarefa (truncada) · estado · Abrir. */
function DelegationRow({ card, teamId }: { card: DelegationCard; teamId: string }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const member = useTeamStore((s) => placeOf(s.teams, card.member)?.member ?? null);
  const name = member?.label ? member.label.split(" · ")[0]! : card.memberName;
  return (
    // Duas linhas: quem e o estado em cima, a tarefa embaixo (numa coluna estreita a tarefa sumia espremida entre os dois).
    <div data-team={teamId} className="flex flex-col min-h-[26px] py-0.5 text-chat-note">
      <div className="flex min-w-0 items-center gap-2">
        <AgentMono agentId={member?.agentId ?? ""} label={name} size={16} />
        <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">{name}</span>
        <span className="shrink-0 whitespace-nowrap text-gray-500 dark:text-white/45">· {roleLabel(member?.role ?? "generalist")}</span>
        <span className="flex-1" />
        <StateDot state={card.state} className="shrink-0 whitespace-nowrap text-chat-caption" />
        <button type="button" onClick={() => openMember(card.member)}
          className="shrink-0 h-7 px-2 rounded-md text-chat-caption text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
          {t("chat.team.open")}
        </button>
      </div>
      <span className="ml-6 min-w-0 truncate text-gray-600 dark:text-white/60" title={card.task}>{card.task}</span>
    </div>
  );
}

/**
 * A entrega que voltou (Handoff v1, lido do backend só quando o grupo abre): uma linha com o resumo
 * truncado; clicar mostra o resumo inteiro, os arquivos e os testes.
 */
function DeliveryRow({ teamId, id, name }: { teamId: string; id: number; name: string }) {
  const { t } = useTranslation();
  const [handoff, setHandoff] = useState<TeamHandoff | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    chatTeamHandoff(teamId, id).then((h) => { if (alive) setHandoff(h); }).catch(() => undefined);
    return () => { alive = false; };
  }, [teamId, id]);
  const body = handoff?.handoff;
  const files = body?.changed_files?.length ?? 0;
  const passed = body?.tests?.filter((x) => x.status === "passed").length ?? 0;
  const failed = body?.tests?.filter((x) => x.status === "failed").length ?? 0;
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-2 min-h-[26px] text-left text-chat-note hover:bg-gray-50 dark:hover:bg-white/[0.04] rounded-md">
        <span className="shrink-0 font-medium text-emerald-700 dark:text-emerald-400">{t("chat.team.feed.delivered", { name, id })}</span>
        <span className="min-w-0 flex-1 truncate text-gray-600 dark:text-white/60">{body ? body.summary : t("chat.team.feed.loading")}</span>
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && body && (
        <div className="ml-1 mb-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] px-3 py-2 text-chat-note">
          <p className="m-0 whitespace-pre-wrap break-words text-gray-800 dark:text-white/85">{body.summary}</p>
          <p className="m-0 mt-1 text-chat-caption text-gray-500 dark:text-white/45">
            {t("chat.team.feed.files", { count: files })} · {t("chat.team.feed.tests", { passed, failed })}
          </p>
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
