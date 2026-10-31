import i18n from "i18next";

import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";

import { openConversation, startConversation } from "../chatActions";
import type { ChatAccess } from "../chatModel";
import { loadChatPrefs } from "../chatPrefs";
import { threadIdOf, threadKey } from "../structured/model";
import { createThread, openThread, settleThread, useStructured } from "../structured/store";
import { launchTeam, type Created, type DraftMember, type LaunchResult, type TeamPort } from "./teamDraft";
import {
  dissolveTeam, linkExisting, linkSpawned, makeOrchestrator, markTold, sendToMember, setComposerTarget, spawnMember, unlinkMember, useTeamStore,
} from "./teamStore";
import { rosterNotice, rosterSignature, routeMessage, type ComposerTarget } from "./teamModel";
import type { TeamPolicy } from "./ipc";

/** Tudo o que se sabe do orquestrador que vai nascer (o que a tela "Nova conversa" escolheu). */
export interface LeadSpec {
  agent: AgentInfo;
  /** A pasta em que a conversa roda (já o worktree novo, se pedido). */
  cwd: string;
  title: string;
  model: string | null;
  effort: string | null;
  access: ChatAccess;
  plan: boolean;
  accountId: string | null;
  /** O valor do seletor de conta (um id, um pool ou `undefined`), como `startConversation` espera. */
  account: string | undefined;
  /** Por protocolo (sem TUI), como as conversas novas do chat. */
  viaProtocol: boolean;
}

const nameOfRef = (ref: string): string | null => {
  const thread = threadIdOf(ref);
  if (thread) return useStructured.getState().threads.find((t) => t.id === thread)?.title ?? null;
  return useTabsStore.getState().tabs.find((t) => t.id === ref)?.title ?? null;
};

/** O `TeamPort` de verdade: aba ou conversa por protocolo, os comandos do time e o envio. */
export function appTeamPort(spec: LeadSpec, prompt: string, target: ComposerTarget): TeamPort {
  const conv = (ref: string) => ({ key: ref, agentId: spec.agent.id, agentLabel: spec.agent.label, title: spec.title, cwd: spec.cwd });
  const close = async (ref: string) => {
    const thread = threadIdOf(ref);
    if (thread) settleThread(thread, true);
    else useTabsStore.getState().closeTab(ref);
  };

  const createLead = async (): Promise<Created> => {
    if (spec.viaProtocol) {
      // No Claude o Plano é um modo de permissão: a conversa nasce nele (como em `startThread`).
      const id = await createThread({
        agentId: spec.agent.id, cwd: spec.cwd, title: spec.title, model: spec.model, effort: spec.effort,
        access: spec.plan ? "plan" : spec.access, accountId: spec.accountId,
      });
      const ref = threadKey(id);
      return { ref, undo: () => close(ref) };
    }
    const ref = await startConversation({
      cwd: spec.cwd, agent: spec.agent, prompt: "", title: spec.title, model: spec.model, effort: spec.effort, account: spec.account,
      access: spec.access, plan: spec.plan, background: true,
    });
    return { ref, undo: () => close(ref) };
  };

  const makeTeam = async (lead: Created): Promise<Created> => {
    const team = await makeOrchestrator(conv(lead.ref));
    return { ref: team.id, undo: () => dissolveTeam(team.id) };
  };

  const linkMember = async (teamId: string, member: DraftMember): Promise<Created> => {
    if (member.kind === "existing") {
      await linkExisting(teamId, member.conv, member.role, member.policy, member.subagent);
      return { ref: member.conv.key, undo: () => unlinkMember(teamId, member.conv.key) };
    }
    const input = {
      teamId, agent: member.agent, role: member.role, policy: member.policy as TeamPolicy, cwd: spec.cwd, worktree: member.worktree,
      model: member.model, effort: member.effort, structured: loadChatPrefs().structured, subagent: member.subagent,
    };
    const spawned = await spawnMember(input);
    const keeps = spawned.place ? `worktree ${spawned.place.branch} (${spawned.place.root})` : undefined;
    try {
      await linkSpawned(input, spawned);
    } catch (e) {
      spawned.close();
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { keeps });
    }
    return { ref: spawned.ref, undo: () => close(spawned.ref), keeps };
  };

  const deliver = (lead: Created, teamId: string): void => {
    const team = useTeamStore.getState().teams.find((t) => t.id === teamId);
    if (!team) throw new Error(i18n.t("chat.team.draft.errors.noTeam"));
    const roleName = (role: string) => i18n.t(`chat.team.roles.${role}`, { defaultValue: role });
    const policyName = (p: TeamPolicy) => i18n.t(`chat.team.policy.${p}`);
    // Só o orquestrador (`lead`) não leva o aviso de elenco: ele responde sozinho.
    const notice = target === "team" ? rosterNotice(team, nameOfRef, roleName, policyName) : null;
    const options = team.members.map((m) => ({ ref: m.member, name: nameOfRef(m.member) ?? (m.label || m.agentId), agentId: m.agentId, role: m.role }));
    const routed = routeMessage(prompt, target, team, options, notice);
    sendToMember(routed.to, routed.text);
    if (!routed.direct && notice) markTold(team.id, rosterSignature(team));
    // A caixa de "para quem" da conversa já nasce como a pessoa deixou na tela de rascunho.
    setComposerTarget(lead.ref, target);
    const thread = threadIdOf(lead.ref);
    if (thread) openThread(thread);
    else openConversation(lead.ref);
  };

  return { createLead, makeTeam, linkMember, deliver };
}

/** Cria a conversa com o time montado. `ok: false` = nada ficou (menos o que `leftovers` diz); o texto segue na caixa. */
export function launchDraftTeam(spec: LeadSpec, members: DraftMember[], prompt: string, target: ComposerTarget): Promise<LaunchResult> {
  return launchTeam(appTeamPort(spec, prompt, target), members);
}
