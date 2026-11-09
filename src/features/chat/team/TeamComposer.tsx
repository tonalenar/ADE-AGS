import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { Attachment } from "../attachments/attachModel";
import { messageFor } from "../attachments/send";
import type { ConversationCard } from "../chatModel";
import type { TeamPolicy, TeamView } from "./ipc";
import { useRoleLabel } from "./TeamParts";
import {
  mentionSlug, rosterNotice, rosterSignature, routeMessage, teamLedBy,
  type ComposerTarget, type MentionOption,
} from "./teamModel";
import type { TimelineItem } from "../timeline/types";
import { markTold, sendDirect, setComposerTarget, setSendError, startTeams, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

/**
 * O composer do orquestrador (prancheta 15): o segmentado "Time | Só o orquestrador", o placeholder
 * "Fale com o time · @codex para um só" e o @agente, que manda a mensagem só para aquele integrante.
 */

/** O segmentado "Para quem". */
export function TeamTargetSwitch({ orchestrator }: { orchestrator: string }) {
  const { t } = useTranslation();
  const target = useTeamStore((s) => s.targets[orchestrator] ?? "team");
  const options: [ComposerTarget, string][] = [["team", t("chat.team.target.team")], ["lead", t("chat.team.target.lead")]];
  return (
    <div role="group" aria-label={t("chat.team.target.label")} className="flex shrink-0 gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.06]">
      {options.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={target === id} onClick={() => setComposerTarget(orchestrator, id)}
          className={`h-7 px-2.5 rounded-md whitespace-nowrap text-chat-caption font-medium
            ${target === id ? "bg-white dark:bg-surface-raised text-gray-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-gray-500 dark:text-white/45"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Os integrantes como opções do @. */
function useMentionOptions(team: TeamView | null, cards: ConversationCard[]): MentionOption[] {
  const live = useTeamLive(cards);
  return useMemo(() => (team ? team.members.map((m) => ({
    ref: m.member, name: live.nameOf(m.member) ?? (m.label || m.agentId), agentId: m.agentId, role: m.role,
  })) : []), [team, live]);
}

export interface TeamComposer {
  /** O placeholder do composer do orquestrador. */
  placeholder: string;
  /** O segmentado, para ir nos `controls` do composer. */
  controls: React.ReactNode;
  /** O erro do último envio direto (@): a conversa que a pessoa está olhando o mostra. */
  error: string | null;
  /** Os nomes dos integrantes para a paleta unificada `@` do composer. */
  mentions: MentionOption[];
  /**
   * Prepara o envio: `null` = já foi direto a um integrante (pelo @), com a bolha pendente na conversa de `where`;
   * senão o texto a mandar ao orquestrador pelo caminho de sempre da conversa (com o resumo do time quando ele
   * mudou, ou o aviso de "Só o orquestrador") e o `onSent`, que quem envia chama DEPOIS de o envio funcionar:
   * só então o resumo conta como entregue.
   */
  prepare: (text: string, where: { key: string; items: TimelineItem[] }, attachments?: Attachment[]) => PreparedSend | null;
}

export interface PreparedSend {
  text: string;
  onSent: () => void;
}

/**
 * O composer de uma conversa que orquestra um time. `null` = a conversa não orquestra (o composer fica
 * como sempre).
 */
export function useTeamComposer(conversation: ConversationCard | null, cards: ConversationCard[]): TeamComposer | null {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  useEffect(() => startTeams(), []);
  const team = useTeamStore((s) => teamLedBy(s.teams, conversation?.tabId));
  const target = useTeamStore((s) => (conversation ? s.targets[conversation.tabId] ?? "team" : "team"));
  const told = useTeamStore((s) => (team ? s.told[team.id] : undefined));
  const live = useTeamLive(cards);
  const options = useMentionOptions(team, cards);

  const orchestrator = conversation?.tabId ?? "";
  const error = useTeamStore((s) => s.sendErrors[orchestrator] ?? null);
  const prepare = useCallback((text: string, where: { key: string; items: TimelineItem[] }, attachments: Attachment[] = []): PreparedSend | null => {
    if (!team) return { text, onSent: () => undefined };
    setSendError(orchestrator, null);
    const signature = rosterSignature(team);
    const policyLabel = (p: TeamPolicy) => t(`chat.team.policy.${p}`);
    const notice = target === "team" && told !== signature ? rosterNotice(team, live.nameOf, roleLabel, policyLabel) : null;
    const routed = routeMessage(text, target, team, options, notice);
    if (routed.direct) {
      // Um anexo vai ao integrante pelo mesmo caminho da mensagem (o caminho no texto nunca se perde).
      const sent = messageFor(routed.to, routed.text, attachments);
      sendDirect(orchestrator, routed.to, sent.text, where, sent.images);
      return null;
    }
    // O resumo do time só conta como entregue depois de o envio funcionar.
    return { text: routed.text, onSent: () => { if (notice) markTold(team.id, signature); } };
  }, [team, target, told, live, roleLabel, options, t, orchestrator]);

  if (!team || !conversation) return null;
  const first = options[0];
  return {
    placeholder: target === "lead"
      ? t("chat.team.placeholderLead")
      : t("chat.team.placeholder", { agent: first ? mentionSlug(first.agentId) : "codex" }),
    controls: <TeamTargetSwitch orchestrator={conversation.tabId} />,
    error,
    mentions: options,
    prepare,
  };
}
