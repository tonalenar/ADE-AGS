import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { startChatLive } from "../liveStore";
import { memberState, orchestratorState, placeOf, stateTone } from "./teamModel";
import { startTeams, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

/**
 * O que o time sabe de um terminal, no cartão dele no canvas: o estado (trabalhando, aguardando,
 * entregou…) e a política de permissão. Vem do mesmo time do modo chat, sem outro canal. O papel e a
 * etiqueta "subagente" já são do cartão. Fora de um time não desenha nada; é um filho do cartão, então
 * o terminal não é remontado.
 */
export function TeamNodeBadge({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  // No canvas ninguém mais abriu o canal do chat nem o time: abre (uma vez por janela).
  useEffect(() => { startTeams(); startChatLive(); }, []);
  const teams = useTeamStore((s) => s.teams);
  const place = useMemo(() => placeOf(teams, tabId), [teams, tabId]);
  const feed = useTeamStore((s) => (place ? s.feeds[place.team.id] : undefined));
  const live = useTeamLive();
  if (!place) return null;
  const items = feed ?? [];
  const state = place.member
    ? memberState(live.liveOf(tabId), items, tabId)
    : orchestratorState(live.liveOf(tabId), place.team.members.map((m) => memberState(live.liveOf(m.member), items, m.member)));
  // O integrante tem política gravada; o orquestrador, o acesso da própria conversa.
  const policy = place.member?.policy ?? live.accessOf(tabId);
  return (
    <span className="shrink-0 inline-flex items-center gap-1" title={t("chat.team.node.title")}>
      <span className={stateTone(state)}>● {t(`chat.team.state.${state}`)}</span>
      {policy && <span className="text-gray-400 dark:text-white/40">· {t(`chat.team.policy.${policy}`)}</span>}
    </span>
  );
}
