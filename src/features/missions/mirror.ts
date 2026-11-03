import { invoke } from "@tauri-apps/api/core";

import type { TeamView } from "@/features/chat/team/ipc";

/**
 * O espelho da missão no chat: ao abrir o time em terminais, a missão grava uma linha `origin = 'mission'` no
 * roster do chat (`chat_team_mission_mirror`) só para o chat, as abas e o canvas MOSTRAREM o grupo "Missão X".
 * A missão segue dona do motor (worktrees, entrega, orçamento, `confirm_spend`, Vigia do front) e do chat da
 * equipe (`m:<id>`); o espelho não manda mensagem, não define política e não vira coroa no canvas.
 */

/** Os estados em que a missão não tem mais time em terminais: o espelho sai. */
const CLOSED = new Set(["done", "done_without_delivery", "cancelled", "failed"]);

export const isMissionMirror = (team: Pick<TeamView, "origin">): boolean => team.origin === "mission";

/** Separa os times do chat/canvas dos espelhos de missão: só os primeiros mexem em política, canvas e vigia do chat. Pura. */
export function splitMirrors(all: TeamView[]): { teams: TeamView[]; missionTeams: TeamView[] } {
  return { teams: all.filter((t) => !isMissionMirror(t)), missionTeams: all.filter(isMissionMirror) };
}

/** O que `chat_team_mission_mirror` recebe (espelho de `chat_team::commands::MirrorInput`). */
export interface MirrorInput {
  missionId: string;
  orchestrator: string;
  agentId: string;
  label: string;
  cwd: string;
  title: string;
  boardKey: string;
  members: { member: string; agentId: string; label: string; role: string; subagent: boolean; branch: string | null; worktree: string | null }[];
}

interface MirrorSource {
  mission: { id: string; title: string; cwd: string };
  boardKey: string;
  /** O orquestrador, como aba aberta. `null` = a missão não tem terminal de orquestrador (Gemini Desktop): sem espelho. */
  lead: { tabId: string; agentId: string; label: string; branch?: string; worktree?: string } | null;
  /** Os integrantes que são abas abertas (os nós de portal, como o Gemini Desktop, não entram). */
  members: { tabId: string; agentId: string; name: string; roleLabel: string; subagent?: boolean; branch?: string; worktree?: string }[];
}

/** O espelho a gravar, ou `null` se não há o que espelhar. Pura. */
export function mirrorInput(source: MirrorSource): MirrorInput | null {
  if (!source.lead?.tabId) return null;
  const { lead } = source;
  return {
    missionId: source.mission.id,
    orchestrator: lead.tabId,
    agentId: lead.agentId,
    label: lead.label,
    cwd: source.mission.cwd,
    title: source.mission.title,
    boardKey: source.boardKey,
    members: source.members
      .filter((m) => m.tabId && m.tabId !== lead.tabId)
      .map((m) => ({ member: m.tabId, agentId: m.agentId, label: m.name, role: m.roleLabel, subagent: m.subagent === true, branch: m.branch ?? null, worktree: m.worktree ?? null })),
  };
}

/** As missões cujo espelho deve sair: a missão fechou (ou já não existe na lista carregada). Pura. */
export function staleMirrors(mirrors: Pick<TeamView, "missionId">[], missions: { id: string; status: string }[]): string[] {
  const status = new Map(missions.map((m) => [m.id, m.status]));
  const out: string[] = [];
  for (const mirror of mirrors) {
    const id = mirror.missionId;
    if (!id) continue;
    const s = status.get(id);
    if (s !== undefined && CLOSED.has(s)) out.push(id);
  }
  return out;
}

export const mirrorMission = (input: MirrorInput) => invoke<{ team: TeamView; skipped: { member: string; reason: string }[] }>("chat_team_mission_mirror", { input });

export const unmirrorMission = (missionId: string) => invoke<boolean>("chat_team_mission_unmirror", { missionId });
