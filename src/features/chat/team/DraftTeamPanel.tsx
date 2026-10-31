import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationCard } from "../chatModel";
import { newDraftId, addToDraft, removeFromDraft, setDraftForm, updateInDraft, useTeamDraft } from "./draftStore";
import { conversationRefOf, LinkAgentFields, type LinkValue } from "./LinkAgentForm";
import { AgentMono, PanelHeader, useRoleLabel } from "./TeamParts";
import { draftMemberName, type DraftMember } from "./teamDraft";
import { takenRefs } from "./teamModel";
import { useTeamStore } from "./teamStore";

/**
 * O painel "Time" da tela "Nova conversa": o time em RASCUNHO. O orquestrador é o agente que o composer
 * escolheu; ligar, editar e remover só mexem no rascunho (memória). O time e as conversas dos
 * integrantes nascem juntos quando a primeira mensagem é enviada (`teamLaunch.ts`).
 */
export function DraftTeamPanel({ cards }: { cards: ConversationCard[] }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const lead = useTeamDraft((s) => s.lead);
  const members = useTeamDraft((s) => s.members);
  const adding = useTeamDraft((s) => s.adding);
  const editing = useTeamDraft((s) => s.editing);
  const teams = useTeamStore((s) => s.teams);
  // Uma conversa aberta só entra uma vez: nem num time que já existe, nem duas vezes no rascunho.
  const taken = useMemo(() => {
    const keys = takenRefs(teams);
    for (const m of members) if (m.kind === "existing") keys.add(m.conv.key);
    return keys;
  }, [teams, members]);
  const usedAgentIds = useMemo(() => [lead?.agentId ?? "", ...members.map((m) => (m.kind === "new" ? m.agent.id : m.conv.agentId))], [lead, members]);

  if (!lead) {
    return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.team.draft.noAgent")}</p>;
  }

  const add = async ({ pick, role, policy, subagent, worktree, model, effort }: LinkValue) => {
    if (!pick) return;
    const base = { id: newDraftId(), role, policy, subagent };
    addToDraft(pick.kind === "new"
      ? { ...base, kind: "new", agent: pick.agent, model, effort, worktree }
      : { ...base, kind: "existing", conv: conversationRefOf(pick.card) });
  };
  const save = (member: DraftMember) => async ({ role, policy, subagent, worktree, model, effort }: LinkValue) => {
    updateInDraft(member.id, member.kind === "new" ? { role, policy, subagent, worktree, model, effort } : { role, policy, subagent });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader summary={t("chat.team.summary", { count: members.length + 1 })}
        onAdd={() => setDraftForm({ adding: !adding, editing: null })} adding={adding} />
      <p className="mx-3.5 mt-2.5 mb-0 flex items-start gap-2 text-chat-caption leading-normal text-gray-500 dark:text-white/45">
        <span className="shrink-0 text-[11px] font-semibold px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">{t("chat.team.draft.badge")}</span>
        <span>{t("chat.team.draft.note")}</span>
      </p>
      {adding && (
        <div className="mt-2.5">
          <LinkAgentFields usedAgentIds={usedAgentIds} taken={taken} cards={cards} dragHint={false}
            submitLabel={t("chat.team.draft.add")} onSubmit={add} onCancel={() => setDraftForm({ adding: false })} />
        </div>
      )}
      <ul aria-label={t("chat.team.title")} className="list-none m-0 p-2.5 flex flex-col gap-2 cc-scroll-hidden min-h-0 flex-1">
        <li className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised px-3 py-2.5 flex items-center gap-2">
          <AgentMono agentId={lead.agentId} label={lead.label} />
          <div className="flex-1 min-w-0">
            <div className="text-chat-note font-semibold text-gray-900 dark:text-white truncate">{lead.label}</div>
            <div className="text-chat-caption text-gray-500 dark:text-white/45 truncate">{t("chat.team.draft.lead")}</div>
          </div>
          <span className="text-[11px] font-semibold px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">{roleLabel("orchestrator")}</span>
        </li>
        {members.map((member) => (editing === member.id ? (
          <li key={member.id} className="list-none -mx-3.5">
            <LinkAgentFields usedAgentIds={usedAgentIds} taken={taken} cards={cards} initial={member} dragHint={false}
              title={t("chat.team.draft.editTitle")} submitLabel={t("chat.team.draft.save")}
              onSubmit={save(member)} onCancel={() => setDraftForm({ editing: null })} />
          </li>
        ) : (
          <MemberRow key={member.id} member={member} />
        )))}
      </ul>
    </div>
  );
}

function MemberRow({ member }: { member: DraftMember }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const name = draftMemberName(member);
  const agentId = member.kind === "new" ? member.agent.id : member.conv.agentId;
  const btn = "h-6 px-1.5 rounded text-[11px] text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white";
  return (
    <li className="group rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <AgentMono agentId={agentId} label={name} />
        <div className="flex-1 min-w-0">
          <div className="text-chat-note font-semibold text-gray-900 dark:text-white truncate">{name}</div>
          <div className="text-chat-caption text-gray-500 dark:text-white/45 truncate">
            {member.kind === "new" ? (member.model ?? t("chat.team.modelDefault")) : t("chat.team.form.existing")}
          </div>
        </div>
        <span className="text-[11px] font-semibold px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">{roleLabel(member.role)}</span>
        {member.subagent && (
          <span className="text-[11px] font-semibold px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">{t("role.subagentTag")}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-chat-caption text-gray-500 dark:text-white/45">
        <span className="whitespace-nowrap">{t(`chat.team.policy.${member.policy}`)}</span>
        <span className="flex-1" />
        {/* Aparecem com o mouse ou com o foco dentro do cartão (o teclado chega neles). */}
        <button type="button" className={`${btn} opacity-0 group-hover:opacity-100 focus:opacity-100`} aria-label={t("chat.team.draft.editAria", { name })}
          onClick={() => setDraftForm({ editing: member.id, adding: false })}>{t("chat.team.draft.edit")}</button>
        <button type="button" className={`${btn} opacity-0 group-hover:opacity-100 focus:opacity-100`} aria-label={t("chat.team.draft.removeAria", { name })}
          onClick={() => removeFromDraft(member.id)}>{t("chat.team.draft.remove")}</button>
      </div>
    </li>
  );
}
