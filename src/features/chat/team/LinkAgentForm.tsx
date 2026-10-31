import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SubagentSwitch } from "@/features/canvas/SubagentSwitch";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";

import { AgentModelPicker, EffortMenu, hasEffort } from "../AgentModelPicker";
import { CheckIcon } from "../chatIcons";
import { loadChatPrefs } from "../chatPrefs";
import type { ConversationCard } from "../chatModel";
import { usePopover } from "../usePopover";
import type { TeamPolicy, TeamView } from "./ipc";
import { AgentMono, useRoleLabel } from "./TeamParts";
import { branchFor, defaultPolicy, POLICIES, TEAM_ROLES, takenRefs } from "./teamModel";
import { draftMemberName, type DraftMember } from "./teamDraft";
import { linkExisting, linkNew, setAdding, useTeamStore, type ConversationRef } from "./teamStore";

/** O que o campo "Agente" escolheu: um agente para uma conversa nova, ou uma conversa aberta. */
export type LinkPick = { kind: "new"; agent: AgentInfo } | { kind: "existing"; card: ConversationCard };

/** O que o formulário devolve ao ligar. `pick` é `null` quando o agente estava travado (edição). */
export interface LinkValue {
  pick: LinkPick | null;
  role: string;
  policy: TeamPolicy;
  subagent: boolean;
  worktree: boolean;
  model: string | null;
  effort: string | null;
}

export function conversationRefOf(card: ConversationCard): ConversationRef {
  return { key: card.tabId, agentId: card.agentId, agentLabel: card.agentLabel, title: card.title, cwd: card.cwd };
}

/**
 * "Ligar ao time" (prancheta 15): o agente (uma conversa nova de um agente, ou uma conversa já aberta),
 * o papel e as permissões; numa conversa nova, o worktree próprio na branch `team/<papel>`. Ou arrastar
 * uma conversa da sidebar para o painel.
 */
export function LinkAgentForm({ team, cards }: { team: TeamView; cards: ConversationCard[] }) {
  const teams = useTeamStore((s) => s.teams);
  const taken = useMemo(() => takenRefs(teams), [teams]);
  const usedAgentIds = useMemo(() => [team.agentId, ...team.members.map((m) => m.agentId)], [team]);
  const submit = async ({ pick, role, policy, subagent, worktree, model, effort }: LinkValue) => {
    if (!pick) return;
    if (pick.kind === "existing") {
      await linkExisting(team.id, conversationRefOf(pick.card), role, policy, subagent);
    } else {
      await linkNew({ teamId: team.id, agent: pick.agent, role, policy, cwd: team.cwd, worktree, model, effort, structured: loadChatPrefs().structured, subagent });
    }
    setAdding(team.id, false);
  };
  return <LinkAgentFields key={team.id} usedAgentIds={usedAgentIds} taken={taken} cards={cards} onSubmit={submit} onCancel={() => setAdding(team.id, false)} />;
}

/**
 * Os campos do formulário, sem saber para onde vão: o time de verdade (`LinkAgentForm`) ou o rascunho
 * da tela "Nova conversa" (`DraftTeamPanel`). `initial` abre já preenchido para editar um integrante do
 * rascunho (o agente fica travado: para trocá-lo, remove-se e liga-se outro).
 */
export function LinkAgentFields({ usedAgentIds, taken, cards, initial = null, title, submitLabel, dragHint = true, onSubmit, onCancel }: {
  /** Os agentes que o time já tem (o formulário sugere um que falte). */
  usedAgentIds: string[];
  /** As conversas que já estão em algum time (não são oferecidas). */
  taken: Set<string>;
  cards: ConversationCard[];
  initial?: DraftMember | null;
  title?: string;
  submitLabel?: string;
  /** Mostra "arraste uma conversa para cá" (só vale no time de verdade). */
  dragHint?: boolean;
  onSubmit: (value: LinkValue) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const detected = useTabsStore((s) => s.detectedAgents);
  const agents = useMemo(() => detected.filter((a) => a.available && a.id !== SHELL_AGENT_ID), [detected]);
  const open = useMemo(() => cards.filter((c) => !taken.has(c.tabId)), [cards, taken]);
  const locked = initial !== null;
  // Como na prancheta: um agente que o time ainda não tem, numa conversa nova; Revisor; Pede tudo.
  const [pick, setPick] = useState<LinkPick | null>(() => {
    if (initial) return initial.kind === "new" ? { kind: "new", agent: initial.agent } : null;
    const used = new Set(usedAgentIds);
    const agent = agents.find((a) => !used.has(a.id)) ?? agents[0];
    return agent ? { kind: "new", agent } : open[0] ? { kind: "existing", card: open[0] } : null;
  });
  // O modelo e o esforço do agente novo (`null` = o padrão dele); trocar de agente zera os dois.
  const [tune, setTune] = useState<{ model: string | null; effort: string | null }>(
    () => (initial?.kind === "new" ? { model: initial.model, effort: initial.effort } : { model: null, effort: null }));
  const choose = (next: LinkPick) => {
    if (!(pick?.kind === "new" && next.kind === "new" && pick.agent.id === next.agent.id)) setTune({ model: null, effort: null });
    setPick(next);
  };
  const [role, setRole] = useState<string>(initial?.role ?? "reviewer");
  const [policy, setPolicy] = useState<TeamPolicy>(initial?.policy ?? "ask");
  const [touchedPolicy, setTouchedPolicy] = useState(locked);
  const [subagent, setSubagent] = useState(initial?.subagent ?? false);
  const [worktree, setWorktree] = useState(initial?.kind === "new" ? initial.worktree : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chooseRole = (next: string) => {
    setRole(next);
    // A política acompanha o papel até a pessoa escolher uma.
    if (!touchedPolicy) setPolicy(defaultPolicy(next));
  };

  const pickLabel = initial ? draftMemberName(initial)
    : !pick ? t("chat.team.form.none")
    : pick.kind === "new" ? t("chat.team.form.newConversation", { agent: pick.agent.label })
    : pick.card.title;
  const fresh = initial ? initial.kind === "new" : pick?.kind === "new";
  const freshAgent = initial?.kind === "new" ? initial.agent : pick?.kind === "new" ? pick.agent : null;

  const submit = async () => {
    if ((!pick && !locked) || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({ pick: locked ? null : pick, role, policy, subagent, worktree, model: tune.model, effort: tune.effort });
    } catch (e) {
      setError(t("chat.team.errors.link", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="group" aria-label={title ?? t("chat.team.form.title")}
      className="mx-3.5 mt-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised px-3 py-2.5 flex flex-col gap-2 text-chat-note">
      <b className="font-semibold text-gray-900 dark:text-white">{title ?? t("chat.team.form.title")}</b>
      <Row label={t("chat.team.form.agent")}>
        {locked ? <span className="truncate text-gray-900 dark:text-white">{pickLabel}</span> : (
        <Menu label={pickLabel} ariaLabel={t("chat.team.form.agent")}>
          {(close) => (
            <>
              {agents.length > 0 && <MenuTitle>{t("chat.team.form.newGroup")}</MenuTitle>}
              {agents.map((agent) => (
                <MenuItem key={`new:${agent.id}`} on={pick?.kind === "new" && pick.agent.id === agent.id}
                  onClick={() => { choose({ kind: "new", agent }); close(); }}>
                  <AgentMono agentId={agent.id} label={agent.label} size={16} />
                  <span className="truncate">{t("chat.team.form.newConversation", { agent: agent.label })}</span>
                </MenuItem>
              ))}
              {open.length > 0 && <MenuTitle>{t("chat.team.form.existing")}</MenuTitle>}
              {open.map((card) => (
                <MenuItem key={card.tabId} on={pick?.kind === "existing" && pick.card.tabId === card.tabId}
                  onClick={() => { choose({ kind: "existing", card }); close(); }}>
                  <AgentMono agentId={card.agentId} label={card.agentLabel} size={16} />
                  <span className="truncate">{card.title}</span>
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        )}
      </Row>
      <Row label={t("chat.team.form.role")}>
        <Menu label={roleLabel(role)} ariaLabel={t("chat.team.form.role")}>
          {(close) => TEAM_ROLES.map((id) => (
            <MenuItem key={id} on={role === id} onClick={() => { chooseRole(id); close(); }}>{roleLabel(id)}</MenuItem>
          ))}
        </Menu>
      </Row>
      <Row label={t("chat.team.form.policy")}>
        <Menu label={t(`chat.team.policyMenu.${policy}`)} ariaLabel={t("chat.team.form.policy")}>
          {(close) => POLICIES.map((id) => (
            <MenuItem key={id} on={policy === id} onClick={() => { setPolicy(id); setTouchedPolicy(true); close(); }}>
              {t(`chat.team.policyMenu.${id}`)}
            </MenuItem>
          ))}
        </Menu>
      </Row>
      {freshAgent && (
        <Row label={t("chat.team.form.model")}>
          <AgentModelPicker agents={[freshAgent]} value={{ agentId: freshAgent.id, model: tune.model, effort: tune.effort, account: null }}
            onChange={(v) => setTune((cur) => ({ ...cur, model: v.model }))} showAccount={false} placement="below" />
        </Row>
      )}
      {freshAgent && (
        // O esforço some nos agentes que não têm (o `EffortMenu` devolve nada).
        <EffortRow agent={freshAgent} model={tune.model} value={tune.effort} onChange={(effort) => setTune((cur) => ({ ...cur, effort }))} />
      )}
      <SubagentSwitch value={subagent} onChange={setSubagent} />
      {fresh && (
        <label className="flex items-center gap-2 text-chat-caption text-gray-600 dark:text-white/60">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} className="accent-accent-600" />
          {t("chat.team.form.worktree", { branch: branchFor(role) })}
        </label>
      )}
      {dragHint && <div className="text-chat-caption text-gray-500 dark:text-white/45">{t("chat.team.form.dragHint")}</div>}
      {error && <p role="alert" className="m-0 text-chat-caption text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="h-[30px] px-3 rounded-lg text-gray-600 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/10">
          {t("chat.team.form.cancel")}
        </button>
        <button type="button" onClick={() => { void submit(); }} disabled={(!pick && !locked) || busy}
          className="h-[30px] px-3 rounded-lg bg-accent-600 text-white font-medium disabled:opacity-50 hover:bg-accent-700">
          {busy ? t("chat.team.form.linking") : submitLabel ?? t("chat.team.form.submit")}
        </button>
      </div>
    </div>
  );
}

function EffortRow({ agent, model, value, onChange }: { agent: AgentInfo; model: string | null; value: string | null; onChange: (effort: string | null) => void }) {
  const { t } = useTranslation();
  if (!hasEffort(agent.id)) return null;
  return (
    <Row label={t("chat.team.form.effort")}>
      <EffortMenu agentId={agent.id} model={model} account={null} value={value} onChange={onChange} placement="below" />
    </Row>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-gray-800 dark:text-white/85">
      <span>{label}</span>
      <span className="flex-1" />
      {children}
    </div>
  );
}

function Menu({ label, ariaLabel, children }: { label: string; ariaLabel: string; children: (close: () => void) => React.ReactNode }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`${ariaLabel}: ${label}`} onClick={() => setOpen(!open)}
        className="h-7 max-w-[220px] px-2.5 rounded-[7px] border border-gray-200 dark:border-white/[0.08] inline-flex items-center gap-1 text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.06]">
        <span className="truncate">{label}</span><span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div role="menu" aria-label={ariaLabel}
          className="absolute right-0 top-full mt-1 z-50 w-64 max-h-72 cc-scroll-hidden p-1 rounded-lg text-chat-note
            bg-white/95 dark:bg-surface-raised/95 backdrop-blur-xl shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuTitle({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-white/35">{children}</div>;
}

function MenuItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} onClick={onClick}
      className={`w-full flex items-center gap-2 min-h-7 px-2 rounded text-left text-gray-800 dark:text-white/85
        ${on ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-100 dark:hover:bg-white/[0.07]"}`}>
      {children}
      <span className="flex-1" />
      {on && <CheckIcon className="w-3.5 h-3.5 shrink-0" />}
    </button>
  );
}
