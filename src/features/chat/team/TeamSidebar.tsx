import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationCard } from "../chatModel";
import { openMember } from "./TeamPanel";
import { AgentMono, StateDot, useRoleLabel } from "./TeamParts";
import { CONVERSATION_DRAG_MIME, memberState, sidebarGrouping, teamLedBy, type SidebarGrouping } from "./teamModel";
import { startTeams, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

/**
 * O time na sidebar (prancheta 15): o selo "TIME · N" no cartão do orquestrador e, embaixo dele, os
 * integrantes indentados com o papel e o estado. Os integrantes saem da lista principal.
 */

/** Quem fica indentado sob quem. `nested` sai da lista principal. */
export function useTeamGrouping(cards: ConversationCard[]): SidebarGrouping {
  const teams = useTeamStore((s) => s.teams);
  useEffect(() => startTeams(), []);
  const keys = cards.map((c) => c.tabId).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => sidebarGrouping(keys ? keys.split("\n") : [], teams), [keys, teams]);
}

/** O selo do cartão do orquestrador: "TIME · 4" (conta o orquestrador). */
export function TeamBadge({ convKey }: { convKey: string }) {
  const { t } = useTranslation();
  const team = useTeamStore((s) => teamLedBy(s.teams, convKey));
  if (!team) return null;
  return <span className="shrink-0 text-[11px] font-semibold text-accent-700 dark:text-accent-400">{t("chat.team.badge", { n: team.headcount })}</span>;
}

/** Os integrantes sob o cartão do orquestrador, indentados, com o papel e o estado. */
export function TeamMembers({ orchestrator, members, cards, selectedId }: {
  orchestrator: string;
  /** As chaves dos integrantes que têm cartão (`useTeamGrouping().groups[orchestrator]`). */
  members: string[];
  cards: ConversationCard[];
  selectedId: string | null;
}) {
  const roleLabel = useRoleLabel();
  const team = useTeamStore((s) => teamLedBy(s.teams, orchestrator));
  const feed = useTeamStore((s) => (team ? s.feeds[team.id] : undefined));
  const live = useTeamLive(cards);
  if (!team || members.length === 0) return null;
  return (
    <div role="group" className="flex flex-col">
      {members.map((ref) => {
        const member = team.members.find((m) => m.member === ref);
        const card = cards.find((c) => c.tabId === ref);
        if (!member) return null;
        const state = memberState(live.liveOf(ref), feed ?? [], ref);
        return (
          <button key={ref} type="button" onClick={() => openMember(ref)} aria-current={selectedId === ref ? "page" : undefined}
            {...conversationDragProps(ref)}
            title={card?.title ?? member.label}
            className={`ml-3.5 flex items-center gap-2 px-2 py-1.5 border-l border-gray-200 dark:border-white/[0.08] text-left text-chat-note
              text-gray-600 dark:text-white/60 hover:bg-white dark:hover:bg-white/[0.05] ${selectedId === ref ? "bg-white dark:bg-white/[0.08]" : ""}`}>
            <AgentMono agentId={member.agentId} label={card?.agentLabel ?? member.label} size={14} />
            <span className="flex-1 min-w-0 truncate">{roleLabel(member.role)}</span>
            <StateDot state={state} className="shrink-0 text-[11px]" />
          </button>
        );
      })}
    </div>
  );
}

/** Deixa arrastar a conversa (o cartão da sidebar) para o painel Time. */
export function conversationDragProps(key: string): { draggable: true; onDragStart: (e: React.DragEvent) => void } {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(CONVERSATION_DRAG_MIME, key);
      e.dataTransfer.effectAllowed = "link";
    },
  };
}

/**
 * Com o time ativo, o painel Time abre no lado direito (prancheta 15): ao abrir uma conversa que
 * orquestra um time ou é integrante de um, uma vez por conversa. Fechar depois é da pessoa.
 */
export function useOpenTeamPanel(convKey: string | null, open: (convKey: string) => void): void {
  const teams = useTeamStore((s) => s.teams);
  const inTeam = !!convKey && teams.some((t) => t.orchestrator === convKey || t.members.some((m) => m.member === convKey));
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!convKey || !inTeam || shown.current === convKey) return;
    shown.current = convKey;
    open(convKey);
  }, [convKey, inTeam, open]);
}
