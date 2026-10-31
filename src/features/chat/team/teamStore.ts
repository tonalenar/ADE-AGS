import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import i18n from "i18next";

import { boardKey, boardKeyOfTab, canvasActions, flushSave, useCanvasStore } from "@/features/canvas/store";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";

import { chatCommand } from "../chatModel";
import { addSurface, useChatStore } from "../store";
import { chatThreadCreate } from "../structured/ipc";
import { STRUCTURED_AGENTS, threadIdOf, threadKey } from "../structured/model";
import { addPending, dropPending } from "../timeline/pending";
import type { TimelineItem } from "../timeline/types";
import { reloadThreads, sendToThread, settleThread } from "../structured/store";
import {
  chatTeamCreate, chatTeamDissolve, chatTeamFeed, chatTeamLink, chatTeamList, chatTeamUnlink, chatTeamUpdate, chatTeamWorktree,
  type TeamFeedItem, type TeamPolicy, type TeamView,
} from "./ipc";
import { chatTeamAllowTools, chatTeamAutoDecide, chatTeamWatch, chatTeamWatchStall } from "../permissions/ipc";
import { canvasPlan, runCanvasPlan } from "./teamCanvas";
import { useTeamIndex } from "./teamIndex";
import { projectCanvas, reversePlan, roleIdOfLabel, type CanvasProjection, type ReverseOp } from "./teamMirror";
import { conversationAccess, defaultPolicy, TEAM_ROLES, type ComposerTarget } from "./teamModel";

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
  /** O erro do último envio direto (@menção) de cada orquestrador: aparece na conversa que a pessoa está olhando. */
  sendErrors: Record<string, string>;
  /** O formulário "Ligar ao time" aberto, por time. */
  adding: Record<string, boolean>;
}

export const useTeamStore = create<TeamState>(() => ({ teams: [], loaded: false, feeds: {}, targets: {}, told: {}, sendErrors: {}, adding: {} }));
// A grade das Abas lê a lista daqui, sem depender deste módulo (ver `teamIndex.ts`).
useTeamStore.subscribe((state, prev) => { if (state.teams !== prev.teams) useTeamIndex.setState({ teams: state.teams }); });

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
    startCanvasMirror();
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
  if (opts.dissolve) delete baselines[team.id];
  if (ops.length === 0) {
    // Nada a mudar: a linha de base só nasce aqui (uma mudança da pessoa ainda por espelhar não é engolida).
    if (!(team.id in baselines)) adoptBaseline(team);
    return Promise.resolve();
  }
  // O canvas muda por obra do time: o observador não pode tomar isso por ação da pessoa.
  syncing = true;
  let touched: string[];
  try {
    touched = runCanvasPlan(ops, {
      boards: () => useCanvasStore.getState().boards,
      connect: canvasActions.connect,
      disconnectPair: canvasActions.disconnectPair,
      toggleOrchestrator: canvasActions.toggleOrchestrator,
      moveTerminals: canvasActions.moveTerminals,
      setRole: canvasActions.setRole,
    });
  } finally {
    syncing = false;
  }
  if (!opts.dissolve) adoptBaseline(team);
  return Promise.all(touched.map((key) => flushSave(key).catch(() => undefined))).then(() => undefined);
}

// ── O espelho canvas -> chat ─────────────────────────────────────────

/**
 * O canvas como o time e a pessoa concordaram por último, por time (`teamMirror.ts`). Só o que muda
 * depois disso, no canvas, é obra da pessoa e vira comando do time. Fica na memória: ao abrir o app, o
 * que já estava no canvas vale como acordado.
 */
const baselines: Record<string, CanvasProjection> = {};
/** O time está escrevendo no canvas agora (chat -> canvas): o observador não reage. */
let syncing = false;
let mirroring = false;
let mirrorAgain = false;
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;

function isAgentTab(ref: string): boolean {
  return useTabsStore.getState().tabs.some((t) => t.id === ref && t.agentId !== SHELL_AGENT_ID);
}

const roleName = (role: string) => i18n.t(`chat.team.roles.${role}`, { defaultValue: role });

function adoptBaseline(team: TeamView): void {
  const projection = projectCanvas(team, useCanvasStore.getState().boards, isAgentTab);
  if (projection) baselines[team.id] = projection;
  else delete baselines[team.id];
}

/** O que a pessoa mudou no canvas, como comandos do time (puro: `reversePlan`). */
function mirrorOps(): ReverseOp[] {
  const { teams } = useTeamStore.getState();
  return reversePlan({
    teams,
    boards: useCanvasStore.getState().boards,
    baselines,
    isAgentTab,
    roleIdOf: (label) => roleIdOfLabel(label, TEAM_ROLES, roleName),
  });
}

async function applyReverse(op: ReverseOp): Promise<void> {
  switch (op.kind) {
    case "link": {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === op.ref);
      if (!tab) return;
      await linkExisting(op.teamId, { key: tab.id, agentId: tab.agentId, agentLabel: tab.agentLabel, title: tab.title, cwd: tab.cwd }, op.role, null, op.subagent);
      return;
    }
    case "unlink":
      await unlinkMember(op.teamId, op.ref);
      return;
    case "update":
      await updateMember(op.teamId, op.ref, { role: op.role, subagent: op.subagent });
      return;
  }
}

async function runMirror(): Promise<void> {
  if (!useTabsStore.getState().hydrated || !useCanvasStore.getState().loaded) return;
  if (mirroring) { mirrorAgain = true; return; }
  mirroring = true;
  try {
    do {
      mirrorAgain = false;
      const ops = mirrorOps();
      // A linha de base passa a ser o canvas de agora ANTES de executar: o que os comandos devolvem ao
      // canvas (chat -> canvas) é adotado de novo em `syncTeamCanvas`.
      for (const team of useTeamStore.getState().teams) adoptBaseline(team);
      for (const op of ops) await applyReverse(op).catch((e) => console.warn("[time] espelho canvas -> chat:", e));
    } while (mirrorAgain);
  } finally {
    mirroring = false;
  }
}

/** Observa o canvas: uma mudança que não veio do time vira, em instantes, comando do time (uma vez por janela). */
function startCanvasMirror(): void {
  useCanvasStore.subscribe((state, prev) => {
    if (syncing || state.boards === prev.boards) return;
    if (mirrorTimer) clearTimeout(mirrorTimer);
    // Arrastar um nó muda o canvas a cada quadro: o plano só roda quando a pessoa parar.
    mirrorTimer = setTimeout(() => { mirrorTimer = null; void runMirror(); }, 300);
  });
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
  // Criar o time é pedido da pessoa: o painel Time abre, uma vez, para ela montar o elenco.
  addSurface("team");
  await syncTeamCanvas(team);
  return team;
}

/**
 * Manda o texto à conversa: a aba (quando a TUI estiver pronta) ou a conversa por protocolo. `onSent`: o backend
 * aceitou (numa aba não há resposta a esperar: vale ao entregar à fila do terminal). `onError`: ele recusou.
 */
export function sendToMember(ref: string, text: string, done?: { onSent?: () => void; onError?: (message: string) => void }, images?: string[]): void {
  const thread = threadIdOf(ref);
  if (thread) {
    sendToThread(thread, text, done?.onError, done?.onSent, images);
    return;
  }
  sendWhenReady(ref, text);
  done?.onSent?.();
}

/** O interruptor «não decidir sozinho» do time: desligado (`enabled = false`), toda permissão espera pela pessoa. */
export function setAutoDecide(teamId: string, enabled: boolean): void {
  useTeamStore.setState((s) => ({ teams: s.teams.map((t) => (t.id === teamId ? { ...t, autoDecide: enabled } : t)) }));
  chatTeamAutoDecide(teamId, enabled).catch(() => void reloadTeams());
}

/** «Acesso total libera ferramentas de fora do shell» (MCP, `Task`…): desligado por padrão; só a pessoa liga. */
export function setAllowTools(teamId: string, enabled: boolean): void {
  useTeamStore.setState((s) => ({ teams: s.teams.map((t) => (t.id === teamId ? { ...t, allowTools: enabled } : t)) }));
  chatTeamAllowTools(teamId, enabled).catch(() => void reloadTeams());
}

/** O vigia do chat avisa o orquestrador dos bloqueios dos integrantes (pedido que espera a pessoa, pergunta, turno que falhou). Ligado por padrão. */
export function setWatch(teamId: string, enabled: boolean): void {
  useTeamStore.setState((s) => ({ teams: s.teams.map((t) => (t.id === teamId ? { ...t, watch: enabled } : t)) }));
  chatTeamWatch(teamId, enabled).catch(() => void reloadTeams());
}

/** ...e também de um integrante sem progresso há muito tempo. Desligado por padrão; só avisa, nunca interrompe. */
export function setWatchStall(teamId: string, enabled: boolean): void {
  useTeamStore.setState((s) => ({ teams: s.teams.map((t) => (t.id === teamId ? { ...t, watchStall: enabled } : t)) }));
  chatTeamWatchStall(teamId, enabled).catch(() => void reloadTeams());
}

export function setSendError(orchestrator: string, message: string | null): void {
  useTeamStore.setState((s) => {
    const sendErrors = { ...s.sendErrors };
    if (message) sendErrors[orchestrator] = message;
    else delete sendErrors[orchestrator];
    return { sendErrors };
  });
}

/**
 * O @agente do composer do orquestrador: manda o texto direto a um integrante. A mensagem aparece como pendente
 * na conversa que a pessoa está olhando (`pending.key`) até o backend responder; se ele recusar, o erro aparece
 * ali (`sendErrors`), não só na conversa do integrante, que a pessoa nem vê.
 */
export function sendDirect(orchestrator: string, member: string, text: string, pending: { key: string; items: TimelineItem[] }, images?: string[]): void {
  setSendError(orchestrator, null);
  const mark = text.trim() ? addPending(pending.key, text.trim(), pending.items) : null;
  const drop = () => { if (mark) dropPending(pending.key, mark); };
  sendToMember(member, text, {
    onSent: drop,
    onError: (message) => { drop(); setSendError(orchestrator, message); },
  }, images);
}

async function finishLink(teamId: string, ref: string, briefing: string): Promise<void> {
  sendToMember(ref, briefing);
  const teams = await reloadTeams();
  const team = teams.find((t) => t.id === teamId);
  if (team) await syncTeamCanvas(team);
  void loadFeed(teamId);
}

/** Liga ao time uma conversa que já existe (escolhida no formulário ou arrastada da sidebar). */
export async function linkExisting(teamId: string, conv: ConversationRef, role: string, policy: TeamPolicy | null, subagent?: boolean): Promise<void> {
  const linked = await chatTeamLink({
    teamId, member: conv.key, agentId: conv.agentId, label: conv.agentLabel, role, policy: policy ?? defaultPolicy(role), origin: "existing", subagent,
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
  /** Já nasce como subagente (o interruptor do canvas). */
  subagent?: boolean;
}

/** Uma conversa aberta para um integrante novo, ainda sem ligar ao time. */
export interface SpawnedMember {
  ref: string;
  label: string;
  /** O worktree `team/<papel>` criado (fica no disco: nada o apaga). */
  place: { cwd: string; branch: string; root: string } | null;
  /** Fecha a conversa (a aba fecha; a por protocolo é concluída). */
  close: () => void;
}

/**
 * Abre a conversa do integrante novo: no worktree `team/<papel>` (se pedido) e com o acesso que a
 * política deixa. A conversa aberta na tela continua a do orquestrador.
 */
export async function spawnMember(input: NewMemberInput): Promise<SpawnedMember> {
  const { agent } = input;
  const place = input.worktree ? await chatTeamWorktree(input.cwd, input.role) : null;
  const cwd = place?.cwd ?? input.cwd;
  const roleLabel = i18n.t(`chat.team.roles.${input.role}`, { defaultValue: input.role });
  const label = `${agent.label} · ${roleLabel}`;
  const { access, plan } = conversationAccess(input.policy, agent.id);
  if (input.structured && STRUCTURED_AGENTS.has(agent.id)) {
    const row = await chatThreadCreate({ agentId: agent.id, cwd, title: label, model: input.model, effort: input.effort ?? null, access: plan ? "plan" : access, accountId: null });
    await reloadThreads();
    return { ref: threadKey(row.id), label, place, close: () => settleThread(row.id, true) };
  }
  const tabs = useTabsStore.getState();
  const before = tabs.activeTabId;
  const command = chatCommand(agent.id, agent.command, { model: input.model, effort: input.effort ?? null, access, plan });
  const ref = tabs.addTab({ cwd, agent: { ...agent, command }, title: label, titleIsCustom: true });
  registerPendingSkillSetup(ref, attachSkillsToTab(ref, tabs.workspaceId, []));
  // A tela segue na conversa do orquestrador (a aba nova não rouba a vez).
  if (before && !useChatStore.getState().thread) useTabsStore.getState().activateTab(before);
  return { ref, label, place, close: () => useTabsStore.getState().closeTab(ref) };
}

/**
 * Abre uma conversa nova para o time e a liga, com o briefing do papel como primeira mensagem. Se ligar
 * falhar, a conversa que acabou de abrir fecha (não sobra uma aba solta).
 */
export async function linkNew(input: NewMemberInput): Promise<string> {
  const spawned = await spawnMember(input);
  try {
    await linkSpawned(input, spawned);
  } catch (e) {
    spawned.close();
    throw e;
  }
  return spawned.ref;
}

/** Liga ao time a conversa que `spawnMember` abriu e entrega o briefing. */
export async function linkSpawned(input: NewMemberInput, spawned: SpawnedMember): Promise<void> {
  const linked = await chatTeamLink({
    teamId: input.teamId, member: spawned.ref, agentId: input.agent.id, label: spawned.label, role: input.role, model: input.model, policy: input.policy,
    branch: spawned.place?.branch ?? null, worktree: spawned.place?.root ?? null, origin: "new", subagent: input.subagent,
  });
  await finishLink(input.teamId, spawned.ref, linked.briefing);
}

/** Tira do time: a corda com o orquestrador sai; a conversa continua aberta. */
export async function unlinkMember(teamId: string, ref: string): Promise<void> {
  await chatTeamUnlink(teamId, ref);
  const teams = await reloadTeams();
  const team = teams.find((t) => t.id === teamId);
  if (team) await syncTeamCanvas(team, { removed: [ref] });
}

export async function updateMember(teamId: string, ref: string, patch: { role?: string; policy?: TeamPolicy; subagent?: boolean }): Promise<void> {
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
