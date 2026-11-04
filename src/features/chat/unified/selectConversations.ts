import type { Board } from "@/features/canvas/board";
import type { ThreadRow } from "@/features/chat/structured/ipc";
import { threadKey } from "@/features/chat/structured/model";
import type { TeamMember, TeamView } from "@/features/chat/team/ipc";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";

import type { UnifiedConversation } from "./types";

/**
 * O seletor do modelo único de conversa: puro, sem React nem store, só as quatro fontes que hoje
 * cada modo lê por conta própria (abas, conversas por protocolo, times do chat e canvas).
 */
export interface UnifiedSources {
  tabs: Pick<Tab, "id" | "title" | "cwd" | "agentId" | "ptyId" | "openedAt">[];
  threads: Pick<ThreadRow, "id" | "agentId" | "cwd" | "title" | "state" | "updatedAt">[];
  teams: TeamView[];
  boards: Record<string, Pick<Board, "nodes" | "roles">>;
}

// Os separadores das chaves dos canvas especiais (`canvas/store.ts`: MISSION_SEP, CONV_SEP, COMPARE_SEP).
// Repetidos aqui para o seletor não puxar o store do canvas, que depende de quase todo o app.
const MISSION_SEP = "#m:";
const SPECIAL_SEPS = [MISSION_SEP, "#c:", "#cmp:"];

const isSpecialKey = (key: string) => SPECIAL_SEPS.some((sep) => key.includes(sep));

function missionOfKey(key: string | undefined): string | undefined {
  const at = key?.indexOf(MISSION_SEP) ?? -1;
  return key && at >= 0 ? key.slice(at + MISSION_SEP.length) : undefined;
}

/** O canvas onde a ref é um nó: o especial (missão, projeto, comparação) vence o da pasta. */
function boardKeyByNode(boards: UnifiedSources["boards"]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, board] of Object.entries(boards)) {
    for (const ref of Object.keys(board.nodes)) {
      const have = out.get(ref);
      if (!have || (isSpecialKey(key) && !isSpecialKey(have))) out.set(ref, key);
    }
  }
  return out;
}

interface TeamSlot { team: TeamView; member?: TeamMember }

function teamSlots(teams: TeamView[]): Map<string, TeamSlot> {
  const out = new Map<string, TeamSlot>();
  for (const team of teams) {
    for (const m of team.members) out.set(m.member, { team, member: m });
    // O orquestrador vence se a mesma ref aparecer também como integrante (dado inconsistente).
    if (team.orchestrator) out.set(team.orchestrator, { team });
  }
  return out;
}

/** Todas as conversas abertas, a mais recente primeiro. Aba de shell não é conversa; protocolo só se ativa. */
export function selectConversations(src: UnifiedSources): UnifiedConversation[] {
  const slots = teamSlots(src.teams);
  const nodeBoard = boardKeyByNode(src.boards);

  const build = (base: Pick<UnifiedConversation, "ref" | "kind" | "agentId" | "cwd" | "title" | "starting" | "openedAt">): UnifiedConversation => {
    const slot = slots.get(base.ref);
    const boardKey = slot?.team.boardKey || nodeBoard.get(base.ref) || undefined;
    const missionId = slot?.team.missionId || missionOfKey(boardKey) || undefined;
    const role = slot?.member?.role || nodeBoardRole(src.boards, boardKey, base.ref);
    return {
      ...base,
      teamId: slot?.team.id,
      role: role || undefined,
      boardKey,
      missionId,
      origin: slot ? slot.team.origin ?? "chat" : undefined,
      lead: !!slot && !slot.member,
      subagent: !!slot?.member?.subagent,
    };
  };

  const tabs = src.tabs
    .filter((t) => t.agentId !== SHELL_AGENT_ID)
    .map((t) => build({ ref: t.id, kind: "pty", agentId: t.agentId, cwd: t.cwd, title: t.title, starting: t.ptyId == null, openedAt: t.openedAt }));
  const threads = src.threads
    .filter((t) => t.state === "active")
    .map((t) => build({ ref: threadKey(t.id), kind: "protocol", agentId: t.agentId, cwd: t.cwd, title: t.title, starting: false, openedAt: t.updatedAt }));
  return [...threads, ...tabs].sort((a, b) => b.openedAt - a.openedAt);
}

function nodeBoardRole(boards: UnifiedSources["boards"], boardKey: string | undefined, ref: string): string | undefined {
  return boardKey ? boards[boardKey]?.roles?.[ref] : undefined;
}

export function conversationOf(all: UnifiedConversation[], ref: string): UnifiedConversation | undefined {
  return all.find((c) => c.ref === ref);
}

/** As conversas de um time: o orquestrador primeiro, depois os integrantes na ordem da lista. */
export function teamConversations(all: UnifiedConversation[], teamId: string): UnifiedConversation[] {
  const mine = all.filter((c) => c.teamId === teamId);
  return [...mine.filter((c) => c.lead), ...mine.filter((c) => !c.lead)];
}
