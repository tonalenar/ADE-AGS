import { invoke } from "@tauri-apps/api/core";
import type { ScopeOverlap } from "@/features/missions/conflictsTypes";

/**
 * O time de agentes do modo chat (`src-tauri/src/chat_team/commands.rs`). As funções são finas: a
 * lógica fica em `teamModel.ts` e o estado em `teamStore.ts`.
 */

/** O que o integrante pode fazer sem perguntar (espelho de `chat_team::model::Policy`). */
export type TeamPolicy = "full" | "edits" | "ask" | "read";

/** Espelho de `chat_team::store::MemberRow`. `member` é o id da aba ou `thread:<id>`. */
export interface TeamMember {
  teamId: string;
  member: string;
  agentId: string;
  label: string;
  role: string;
  model: string | null;
  policy: TeamPolicy;
  branch: string | null;
  worktree: string | null;
  origin: "new" | "existing" | string;
  position: number;
  createdAt: number;
  updatedAt: number;
  /** Marcado como subagente (o mesmo interruptor do canvas): só executa o que o orquestrador envia. */
  subagent: boolean;
}

/** Espelho de `chat_team::api::TeamView`. */
export interface TeamView {
  id: string;
  /** A conversa que coordena: o id da aba ou `thread:<id>`. */
  orchestrator: string;
  agentId: string;
  label: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** O backend decide sozinho o que a política e as regras da pessoa cobrem. Ausente = ligado. */
  autoDecide?: boolean;
  /** O acesso total libera ferramentas de fora do shell (MCP, `Task`…). Ausente = desligado. */
  allowTools?: boolean;
  /** O vigia do chat avisa o orquestrador dos bloqueios dos integrantes. Ausente = ligado. */
  watch?: boolean;
  /** ...e de um integrante sem progresso. Ausente = desligado. */
  watchStall?: boolean;
  members: TeamMember[];
  /** Os integrantes mais o orquestrador. */
  headcount: number;
  /** Os novos que ainda estão entrando ou que não chegaram a entrar (ausente em backend antigo). */
  provisions?: TeamProvision[];
}

/** Espelho de `chat_team::api::FeedItem`. */
export interface TeamFeedItem {
  id: number;
  kind: "delegation" | "delivery" | "reply";
  member: string;
  memberName: string;
  task: string;
  state: string;
  at: number;
  handoff: number | null;
}

/** O Handoff v1 de uma entrega (`runs::handoff`), como o resumo do fio lê. */
export interface TeamHandoff {
  id: number;
  from: string;
  handoff: {
    summary?: string;
    changed_files?: { path: string; description?: string }[];
    tests?: { command: string; status: "passed" | "failed" | "not_run" }[];
    risks?: string[];
    next_steps?: string[];
  };
}

export interface LinkInput {
  teamId: string;
  member: string;
  agentId: string;
  label: string;
  role: string;
  model?: string | null;
  policy?: TeamPolicy | null;
  branch?: string | null;
  worktree?: string | null;
  origin?: "new" | "existing";
  /** `undefined` = não disse: nasce como não subagente (e, se já estava no time, fica como está). */
  subagent?: boolean;
  /** O integrante novo gravado por `chatTeamProvisionBegin` antes de abrir a conversa. */
  provision?: string | null;
}

/** Um integrante novo, do pedido até entrar no time (`chat_team/store.rs::ProvisionRow`). */
export interface TeamProvision {
  id: string;
  teamId: string;
  /** Único entre todos os que o time já teve ("Codex · QA 2"). */
  label: string;
  agentId: string;
  role: string;
  member: string | null;
  worktree: string | null;
  branch: string | null;
  state: "provisioning" | "active" | "failed";
  failure: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Linked {
  member: TeamMember;
  /** O texto que o integrante recebe ao entrar (a tela manda à aba ou à conversa). */
  briefing: string;
  roleLabel: string;
}

export const chatTeamList = () => invoke<TeamView[]>("chat_team_list");

export const chatTeamCreate = (input: { orchestrator: string; agentId: string; label: string; cwd: string; title: string }) =>
  invoke<TeamView>("chat_team_create", { input });

export const chatTeamLink = (input: LinkInput) => invoke<Linked>("chat_team_link", { input });

/** Grava o integrante novo (`provisioning`) ANTES de abrir a conversa e o worktree; devolve o nome único. */
export const chatTeamProvisionBegin = (input: { teamId: string; agentId: string; role: string; label: string }) =>
  invoke<TeamProvision>("chat_team_provision_begin", { input });

export const chatTeamProvisionPlace = (id: string, worktree: string | null, branch: string | null) =>
  invoke<void>("chat_team_provision_place", { id, worktree, branch });

export const chatTeamProvisionFail = (id: string, member: string | null, reason: string) =>
  invoke<boolean>("chat_team_provision_fail", { id, member, reason });

export const chatTeamUnlink = (teamId: string, member: string) => invoke<boolean>("chat_team_unlink", { teamId, member });

export const chatTeamUpdate = (input: { teamId: string; member: string; role?: string; policy?: TeamPolicy; label?: string; subagent?: boolean }) =>
  invoke<TeamMember>("chat_team_update", { input });

export const chatTeamDissolve = (teamId: string) => invoke<boolean>("chat_team_dissolve", { teamId });

export const chatTeamFeed = (teamId: string, limit?: number) => invoke<TeamFeedItem[]>("chat_team_feed", { teamId, limit: limit ?? null });

export const chatTeamHandoff = (teamId: string, id: number) => invoke<TeamHandoff>("chat_team_handoff", { teamId, id });

export const chatTeamNotice = (teamId: string) => invoke<string>("chat_team_notice", { teamId });

/** Um worktree `team/<papel>` para um integrante novo (a partir do último commit da pasta). */
export const chatTeamWorktree = (cwd: string, role: string) => invoke<{ cwd: string; branch: string; root: string }>("chat_team_worktree", { cwd, role });

/** As delegações em andamento do time com escopos de escrita sobrepostos (`Escopo:` na delegação). Só aviso. */
export const chatTeamOverlaps = (teamId: string) =>
  invoke<ScopeOverlap[]>("chat_team_overlaps", { teamId });
