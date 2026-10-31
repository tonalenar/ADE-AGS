import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { Attachment } from "../attachments/attachModel";
import { messageFor } from "../attachments/send";
import type { ConversationCard } from "../chatModel";
import type { TeamPolicy, TeamView } from "./ipc";
import { AgentMono, useRoleLabel } from "./TeamParts";
import {
  applyMention, mentionOptions, mentionQuery, mentionSlug, rosterNotice, rosterSignature, routeMessage, teamLedBy,
  type ComposerTarget, type MentionOption,
} from "./teamModel";
import { markTold, sendToMember, setComposerTarget, startTeams, useTeamStore } from "./teamStore";
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
  /**
   * Prepara o envio: `null` = já foi direto a um integrante (pelo @); um texto = o que mandar ao
   * orquestrador pelo caminho de sempre da conversa (com o resumo do time quando ele mudou, ou o aviso
   * de "Só o orquestrador").
   */
  prepare: (text: string, attachments?: Attachment[]) => string | null;
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

  const prepare = useCallback((text: string, attachments: Attachment[] = []): string | null => {
    if (!team) return text;
    const signature = rosterSignature(team);
    const policyLabel = (p: TeamPolicy) => t(`chat.team.policy.${p}`);
    const notice = target === "team" && told !== signature ? rosterNotice(team, live.nameOf, roleLabel, policyLabel) : null;
    const routed = routeMessage(text, target, team, options, notice);
    if (routed.direct) {
      // Um anexo vai ao integrante pelo mesmo caminho da mensagem (o caminho no texto nunca se perde).
      const sent = messageFor(routed.to, routed.text, attachments);
      sendToMember(routed.to, sent.text, sent.images);
      return null;
    }
    if (notice) markTold(team.id, signature);
    return routed.text;
  }, [team, target, told, live, roleLabel, options, t]);

  if (!team || !conversation) return null;
  const first = options[0];
  return {
    placeholder: target === "lead"
      ? t("chat.team.placeholderLead")
      : t("chat.team.placeholder", { agent: first ? mentionSlug(first.agentId) : "codex" }),
    controls: <TeamTargetSwitch orchestrator={conversation.tabId} />,
    prepare,
  };
}

/**
 * O menu do @agente, acima da caixa do composer: aparece enquanto se escreve `@algo` e troca pelo
 * apelido do integrante escolhido. `apply` recebe o texto e o cursor novos.
 */
export function TeamMentionMenu({ conversation, cards, text, caret, apply }: {
  conversation: ConversationCard | null;
  cards: ConversationCard[];
  text: string;
  caret: number;
  apply: (text: string, caret: number) => void;
}) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const team = useTeamStore((s) => teamLedBy(s.teams, conversation?.tabId));
  const options = useMentionOptions(team, cards);
  const found = mentionQuery(text, caret);
  if (!team || !found) return null;
  const hits = mentionOptions(options, found.query);
  if (hits.length === 0) return null;
  return (
    <div role="listbox" aria-label={t("chat.team.mention.label")}
      className="mx-3 mt-2 p-1 rounded-lg text-chat-note bg-white/95 dark:bg-surface-raised/95 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_8px_24px_-12px_rgba(0,0,0,0.45)]">
      {hits.map((o) => (
        <button key={o.ref} type="button" role="option" aria-selected={false}
          onMouseDown={(e) => { e.preventDefault(); const next = applyMention(text, caret, o.name); apply(next.text, next.caret); }}
          className="w-full flex items-center gap-2 h-7 px-2 rounded text-left text-gray-800 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07]">
          <AgentMono agentId={o.agentId} label={o.name} size={16} />
          <span className="truncate">{o.name}</span>
          <span className="text-gray-400 dark:text-white/35">@{mentionSlug(o.name)}</span>
          <span className="flex-1" />
          <span className="text-[11px] text-gray-500 dark:text-white/45">{roleLabel(o.role)}</span>
        </button>
      ))}
    </div>
  );
}
