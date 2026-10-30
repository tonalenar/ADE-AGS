import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationCard } from "../chatModel";
import { chatTeamHandoff, type TeamHandoff } from "./ipc";
import { openMember } from "./TeamPanel";
import { AgentMono, StateDot, useRoleLabel } from "./TeamParts";
import { deliveries, delegationCards, memberState, placeOf, teamLedBy, type DelegationCard } from "./teamModel";
import { loadFeed, startTeams, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

/**
 * No fio do orquestrador (prancheta 15): cada delegação vira um cartão (agente · papel · tarefa · estado ·
 * Abrir) e cada entrega volta como resumo (o Handoff v1). Vai depois da timeline da conversa.
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
  const delivered = useMemo(() => deliveries(items), [items]);
  if (!team || (delegations.length === 0 && delivered.length === 0)) return null;
  return (
    <section aria-label={t("chat.team.feed.label")} className="flex flex-col gap-3.5 text-chat-prose">
      {delegations.map((card) => <DelegationRow key={card.id} card={card} teamId={team.id} />)}
      {delivered.filter((d) => d.handoff !== null).map((d) => <DeliverySummary key={d.id} teamId={team.id} id={d.handoff!} name={live.nameOf(d.member) ?? d.memberName} />)}
      <p className="m-0 text-chat-note text-gray-500 dark:text-white/45">{t("chat.team.feed.footer")}</p>
    </section>
  );
}

function DelegationRow({ card, teamId }: { card: DelegationCard; teamId: string }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const member = useTeamStore((s) => placeOf(s.teams, card.member)?.member ?? null);
  const name = member?.label ? member.label.split(" · ")[0]! : card.memberName;
  return (
    <div data-team={teamId} className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised px-3 py-2.5 flex items-center gap-2.5">
      <AgentMono agentId={member?.agentId ?? ""} label={name} />
      <div className="flex-1 min-w-0">
        <div className="text-chat-note text-gray-900 dark:text-white">
          <b className="font-semibold">{name}</b>{" "}
          <span className="text-gray-500 dark:text-white/45">· {roleLabel(member?.role ?? "generalist")}</span>
        </div>
        <div className="text-chat-note text-gray-600 dark:text-white/60 truncate" title={card.task}>{card.task}</div>
      </div>
      <StateDot state={card.state} className="shrink-0 text-chat-caption" />
      <button type="button" onClick={() => openMember(card.member)}
        className="h-7 px-2.5 rounded-[7px] border border-gray-200 dark:border-white/[0.08] text-chat-note text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.06]">
        {t("chat.team.open")}
      </button>
    </div>
  );
}

/** A entrega que voltou: o resumo, os arquivos e os testes do Handoff v1 (lido do backend). */
function DeliverySummary({ teamId, id, name }: { teamId: string; id: number; name: string }) {
  const { t } = useTranslation();
  const [handoff, setHandoff] = useState<TeamHandoff | null>(null);
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
    <div className="rounded-xl border border-emerald-600/25 dark:border-emerald-400/20 bg-emerald-50/60 dark:bg-emerald-400/[0.06] px-3 py-2.5 text-chat-note">
      <div className="font-semibold text-emerald-800 dark:text-emerald-300">{t("chat.team.feed.delivered", { name, id })}</div>
      {body ? (
        <>
          <p className="m-0 mt-1 text-gray-800 dark:text-white/85">{body.summary}</p>
          <p className="m-0 mt-1 text-chat-caption text-gray-500 dark:text-white/45">
            {t("chat.team.feed.files", { count: files })} · {t("chat.team.feed.tests", { passed, failed })}
          </p>
        </>
      ) : <p className="m-0 mt-1 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.team.feed.loading")}</p>}
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
