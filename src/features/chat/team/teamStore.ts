import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import i18n from "i18next";

import { boardKey, boardKeyOfTab, canvasActions, flushSave, useCanvasStore } from "@/features/canvas/store";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";

import { chatCommand } from "../chatModel";
import { useChatStore } from "../store";
import { chatThreadCreate } from "../structured/ipc";
import { STRUCTURED_AGENTS, threadIdOf, threadKey } from "../structured/model";
import { reloadThreads, sendToThread } from "../structured/store";
import {
  chatTeamCreate, chatTeamDissolve, chatTeamFeed, chatTeamLink, chatTeamList, chatTeamUnlink, chatTeamUpdate, chatTeamWorktree,
  type TeamFeedItem, type TeamPolicy, type TeamView,
} from "./ipc";
import { canvasPlan, runCanvasPlan } from "./teamCanvas";
import { conversationAccess, defaultPolicy, type ComposerTarget } from "./teamModel";

/**
 * Os times do modo chat na janela: a lista (do banco), o fio de cada um (delegações e entregas, da fila
 * de mensagens), o destino do composer de cada orquestrador e o resumo já mandado. Ligar, desligar e
 * desfazer passam por aqui e terminam aplicando o time no canvas (as cordas são a autorização).
 */
interface TeamState {
  teams: TeamView[];
  loaded: boolean;
  /** O fio de cada time, por id. */
  feeds: Record<string, TeamFeedItem[]>;
  /** "Time" ou "Só o orquestrador", por orquestrador. Ausente = Time. */
  targets: Record<string, ComposerTarget>;
  /** A composição do time que o orquestrador já recebeu (`rosterSignature`), por time. */
  told: Record<string, string>;
  /** O formulário "Ligar ao time" aberto, por time. */
  adding: Record<string, boolean>;
}

export const useTeamStore = create<TeamState>(() => ({ teams: [], loaded: false, feeds: {}, targets: {}, told: {}, adding: {} }));

let started = false;

function upsertTeam(team: TeamView): void {
  useTeamStore.setState((s) => ({ teams: s.teams.some((t) => t.id === team.id) ? s.teams.map((t) => (t.id === team.id ? team : t)) : [...s.teams, team] }));
}

export async function reloadTeams(): Promise<TeamView[]> {
  const teams = await chatTeamList();
  useTeamStore.setState({ teams, loaded: true });
  return teams;
}

export async function loadFeed(teamId: string): Promise<void> {
  const feed = await chatTeamFeed(teamId).catch(() => null);
  if (feed) useTeamStore.setState((s) => ({ feeds: { ...s.feeds, [teamId]: feed } }));
}

/** Começa a ouvir o backend (uma vez por janela). Sem Tauri (testes), não faz nada. */
export function startTeams(): void {
  if (started) return;
  started = true;
  try {
    reloadTeams().then((teams) => { for (const t of teams) { void loadFeed(t.id); void syncTeamCanvas(t); } }).catch(() => undefined);
    // As abas e o canvas voltam do disco depois: aí o time é posto em dia (uma vez).
    let synced = false;
    const whenReady = () => {
      if (synced || !useTabsStore.getState().hydrated || !useCanvasStore.getState().loaded) return;
      synced = true;
      for (const t of useTeamStore.getState().teams) void syncTeamCanvas(t);
    };
    useTabsStore.subscribe(whenReady);
    useCanvasStore.subscribe(whenReady);
    // Mudou pela tela, pela CLI ou pelo MCP: relê e põe o canvas em dia (idempotente).
    listen<{ teamId: string }>("cc-chat-team", (e) => {
      reloadTeams()
        .then((teams) => {
          const team = teams.find((t) => t.id === e.payload.teamId);
          if (team) { void syncTeamCanvas(team); void loadFeed(team.id); }
        })
        .catch(() => undefined);
    }).catch(() => undefined);
    // Uma mensagem entre agentes de um time: o fio dele muda.
    listen<{ fromTabId: string; toTabId: string | null }>("cc-peer-message", (e) => {
      const refs = [e.payload.fromTabId, e.payload.toTabId];
      for (const team of useTeamStore.getState().teams) {
        const inTeam = (ref: string | null) => !!ref && (ref === team.orchestrator || team.members.some((m) => m.member === ref));
        if (refs.some(inTeam)) void loadFeed(team.id);
      }
    }).catch(() => undefined);
  } catch {
    // fora do app
  }
}

// ── O canvas ─────────────────────────────────────────────────────────

/** Põe o time no canvas (coroa, cordas, papéis) e grava já: o próximo `ags peer tell` já pode passar. */
export function syncTeamCanvas(team: TeamView, opts: { removed?: string[]; dissolve?: boolean } = {}): Promise<void> {
  // Antes de as abas e os canvases voltarem do disco, "a aba não existe" é falso (ver `canvas/store.ts`).
  if (!useTabsStore.getState().hydrated || !useCanvasStore.getState().loaded) return Promise.resolve();
  const tabs = useTabsStore.getState().tabs;
  const ops = canvasPlan({
    team,
    boards: useCanvasStore.getState().boards,
    keyOfTab: (ref) => {
      const tab = tabs.find((t) => t.id === ref);
      return tab ? boardKeyOfTab(tab) : null;
    },
    folderKey: boardKey,
    roleLabel: (role) => i18n.t(`chat.team.roles.${role}`, { defaultValue: role }),
    ...opts,
  });
  if (ops.length === 0) return Promise.resolve();
  const touched = runCanvasPlan(ops, {
    boards: () => useCanvasStore.getState().boards,
    connect: canvasActions.connect,
    disconnectPair: canvasActions.disconnectPair,
    toggleOrchestrator: canvasActions.toggleOrchestrator,
    moveTerminals: canvasActions.moveTerminals,
    setRole: canvasActions.setRole,
  });
  return Promise.all(touched.map((key) => flushSave(key).catch(() => undefined))).then(() => undefined);
}

// ── Ações da tela ────────────────────────────────────────────────────

/** O que se sabe da conversa que vira orquestradora (o cartão da sidebar). */
export interface ConversationRef {
  /** O id da aba ou `thread:<id>`. */
  key: string;
  agentId: string;
  agentLabel: string;
  title: string;
  cwd: string;
}

/** "Tornar orquestrador": a conversa passa a coordenar um time (idempotente). */
export async function makeOrchestrator(conv: ConversationRef): Promise<TeamView> {
  const team = await chatTeamCreate({ orchestrator: conv.key, agentId: conv.agentId, label: conv.agentLabel, cwd: conv.cwd, title: conv.title });
  upsertTeam(team);
  await syncTeamCanvas(team);
  return team;
}

/** Manda o texto à conversa: a aba (quando a TUI estiver pronta) ou a conversa por protocolo. */
export function sendToMember(ref: string, text: string): void {
  const thread = threadIdOf(ref);
  if (thread) sendToThread(thread, text);
  else sendWhenReady(ref, text);
}

async function finishLink(teamId: string, ref: string, briefing: string): Promise<void> {
  sendToMember(ref, briefing);
  const teams = await reloadTeams();
  const team = teams.find((t) => t.id === teamId);
  if (team) await syncTeamCanvas(team);
  void loadFeed(teamId);
}

/** Liga ao time uma conversa que já existe (escolhida no formulário ou arrastada da sidebar). */
export async function linkExisting(teamId: string, conv: ConversationRef, role: string, policy: TeamPolicy | null): Promise<void> {
  const linked = await chatTeamLink({
    teamId, member: conv.key, agentId: conv.agentId, label: conv.agentLabel, role, policy: policy ?? defaultPolicy(role), origin: "existing",
  });
  await finishLink(teamId, conv.key, linked.briefing);
}

export interface NewMemberInput {
  teamId: string;
  agent: AgentInfo;
  role: string;
  policy: TeamPolicy;
  /** A pasta do orquestrador (o worktree sai dela). */
  cwd: string;
  /** Um worktree próprio, na branch `team/<papel>`. */
  worktree: boolean;
  model: string | null;
  /** O esforço do agente novo (`null` = o padrão dele; só vale nos agentes que têm esforço). */
  effort?: string | null;
  /** Por protocolo, sem TUI (Codex e Claude Code), como as conversas novas do chat. */
  structured: boolean;
}

/**
 * Abre uma conversa nova para o time e a liga: no worktree `team/<papel>` (se pedido), com o acesso que
 * a política deixa, e com o briefing do papel como primeira mensagem. A conversa aberta na tela continua
 * a do orquestrador.
 */
export async function linkNew(input: NewMemberInput): Promise<string> {
  const { agent } = input;
  const place = input.worktree ? await chatTeamWorktree(input.cwd, input.role) : null;
  const cwd = place?.cwd ?? input.cwd;
  const roleLabel = i18n.t(`chat.team.roles.${input.role}`, { defaultValue: input.role });
  const label = `${agent.label} · ${roleLabel}`;
  const { access, plan } = conversationAccess(input.policy, agent.id);
  let ref: string;
  if (input.structured && STRUCTURED_AGENTS.has(agent.id)) {
    const row = await chatThreadCreate({ agentId: agent.id, cwd, title: label, model: input.model, effort: input.effort ?? null, access: plan ? "plan" : access, accountId: null });
    await reloadThreads();
    ref = threadKey(row.id);
  } else {
    const tabs = useTabsStore.getState();
    const before = tabs.activeTabId;
    const command = chatCommand(agent.id, agent.command, { model: input.model, effort: input.effort ?? null, access, plan });
    ref = tabs.addTab({ cwd, agent: { ...agent, command }, title: label, titleIsCustom: true });
    registerPendingSkillSetup(ref, attachSkillsToTab(ref, tabs.workspaceId, []));
    // A tela segue na conversa do orquestrador (a aba nova não rouba a vez).
    if (before && !useChatStore.getState().thread) useTabsStore.getState().activateTab(before);
  }
  const linked = await chatTeamLink({
    teamId: input.teamId, member: ref, agentId: agent.id, label, role: input.role, model: input.model, policy: input.policy,
    branch: place?.branch ?? null, worktree: place?.root ?? null, origin: "new",
  });
  await finishLink(input.teamId, ref, linked.briefing);
  return ref;
}

/** Tira do time: a corda com o orquestrador sai; a conversa continua aberta. */
export async function unlinkMember(teamId: string, ref: string): Promise<void> {
  await chatTeamUnlink(teamId, ref);
  const teams = await reloadTeams();
  const team = teams.find((t) => t.id === teamId);
  if (team) await syncTeamCanvas(team, { removed: [ref] });
}

export async function updateMember(teamId: string, ref: string, patch: { role?: string; policy?: TeamPolicy }): Promise<void> {
  await chatTeamUpdate({ teamId, member: ref, ...patch });
  const teams = await reloadTeams();
  const team = teams.find((t) => t.id === teamId);
  if (team) await syncTeamCanvas(team);
}

/** Desfaz o time (só a pessoa): saem as cordas e a coroa; as conversas continuam. */
export async function dissolveTeam(teamId: string): Promise<void> {
  const team = useTeamStore.getState().teams.find((t) => t.id === teamId);
  if (team) await syncTeamCanvas(team, { dissolve: true });
  await chatTeamDissolve(teamId);
  await reloadTeams();
}

export function setComposerTarget(orchestrator: string, target: ComposerTarget): void {
  useTeamStore.setState((s) => ({ targets: { ...s.targets, [orchestrator]: target } }));
}

export function markTold(teamId: string, signature: string): void {
  useTeamStore.setState((s) => ({ told: { ...s.told, [teamId]: signature } }));
}

export function setAdding(teamId: string, open: boolean): void {
  useTeamStore.setState((s) => ({ adding: { ...s.adding, [teamId]: open } }));
}
