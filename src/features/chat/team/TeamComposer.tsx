import { useCallback, useEffect, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { Attachment } from "../attachments/attachModel";
import { messageFor } from "../attachments/send";
import type { ConversationCard } from "../chatModel";
import type { TeamPolicy, TeamView } from "./ipc";
import { UsersIcon } from "../chatIcons";
import { usePopover } from "../usePopover";
import { useRoleLabel } from "./TeamParts";
import {
  mentionSlug, rosterNotice, rosterSignature, routeMessage, teamLedBy,
  type ComposerTarget, type MentionOption,
} from "./teamModel";
import type { TimelineItem } from "../timeline/types";
import { markTold, sendDirect, setComposerTarget, setSendError, startTeams, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

/**
 * O composer do orquestrador (prancheta 15): o chip «Para quem» ("Time" ou "Só o orquestrador"), o placeholder
 * "Fale com o time · @codex para um só" e o @agente, que manda a mensagem só para aquele integrante.
 */

/**
 * O «Para quem» do orquestrador, em formato de chip discreto (como os controles do T3 Code): mostra o alvo atual e
 * abre um painel com as duas opções, «Time» e «Só o orquestrador». Em coluna estreita o chip fica só com o ícone. O
 * painel fica montado e só some por CSS, e o grupo `role="group"` com os dois botões segue sendo o ponto de acesso.
 */
export function TeamTargetSwitch({ orchestrator }: { orchestrator: string }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const panelId = useId();
  const target = useTeamStore((s) => s.targets[orchestrator] ?? "team");
  const options: [ComposerTarget, string][] = [["team", t("chat.team.target.team")], ["lead", t("chat.team.target.lead")]];
  const current = target === "lead" ? options[1][1] : options[0][1];
  const label = `${t("chat.team.target.label")}: ${current}`;
  return (
    <div ref={ref} className="relative shrink-0 flex items-center">
      <button type="button" data-team-target-chip="" aria-expanded={open} aria-controls={panelId} aria-label={label} title={label}
        onClick={() => setOpen(!open)}
        className={`flex shrink-0 items-center gap-1.5 h-7 px-2 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-600 dark:text-white/55 hover:bg-gray-100 dark:hover:bg-white/[0.07] hover:text-gray-900 dark:hover:text-white
          ${open ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
        <UsersIcon className="w-4 h-4 shrink-0 text-gray-500 dark:text-white/45" />
        {/* Coluna estreita: só o ícone; o rótulo segue para o leitor de tela e o tooltip diz o alvo. */}
        <span className="@max-[30rem]/composer:sr-only">{current}</span>
      </button>
      <div id={panelId} role="group" aria-label={t("chat.team.target.label")}
        className={`${open ? "flex" : "hidden"} absolute bottom-full left-0 z-30 mb-2 gap-0.5 p-0.5 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-white dark:bg-surface-raised shadow-xl`}>
        {options.map(([id, text]) => (
          <button key={id} type="button" aria-pressed={target === id} onClick={() => { setComposerTarget(orchestrator, id); setOpen(false); }}
            className={`h-7 px-2.5 rounded-lg whitespace-nowrap text-chat-caption font-medium
              ${target === id ? "bg-gray-100 dark:bg-white/[0.10] text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.07]"}`}>
            {text}
          </button>
        ))}
      </div>
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
  /** O chip «Para quem», para ir no `leading` do composer. */
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
