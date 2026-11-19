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
  threads: Pick<ThreadRow, "id" | "agentId" | "cwd" | "title" | "state" | "updatedAt" | "parentRef">[];
  teams: TeamView[];
  boards: Record<string, Pick<Board, "nodes" | "threads" | "roles" | "edges">>;
  cwdKey?: (cwd: string) => string;
}

// Os separadores das chaves dos canvas especiais (`canvas/store.ts`: MISSION_SEP, CONV_SEP, COMPARE_SEP).
// Repetidos aqui para o seletor não puxar o store do canvas, que depende de quase todo o app.
const MISSION_SEP = "#m:";
// #s: é especial para encontrar o canvas da conversa, mas não cria escopo de time.
const LEGACY_SPECIAL_SEPS = [MISSION_SEP, "#c:", "#cmp:"];
const CANVAS_SCOPE_SEPS = [...LEGACY_SPECIAL_SEPS, "#s:"];

const isLegacySpecialKey = (key: string) => LEGACY_SPECIAL_SEPS.some((sep) => key.includes(sep));

function missionOfKey(key: string | undefined): string | undefined {
  const at = key?.indexOf(MISSION_SEP) ?? -1;
  return key && at >= 0 ? key.slice(at + MISSION_SEP.length) : undefined;
}

/** O canvas onde a ref é um nó: o especial (missão, projeto, comparação) vence o da pasta. */
function boardKeyByNode(boards: UnifiedSources["boards"]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, board] of Object.entries(boards)) {
    if (!CANVAS_SCOPE_SEPS.some((sep) => key.includes(sep))) continue;
    for (const ref of [...Object.keys(board.nodes), ...Object.keys(board.threads ?? {})]) {
      const have = out.get(ref);
      if (!have || (isLegacySpecialKey(key) && !isLegacySpecialKey(have))) out.set(ref, key);
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

  const build = (base: Pick<UnifiedConversation, "ref" | "kind" | "agentId" | "cwd" | "title" | "parentRef" | "starting" | "openedAt">): UnifiedConversation => {
    const slot = slots.get(base.ref);
    const folderKey = (src.cwdKey ?? ((cwd) => `main|${cwd}`))(base.cwd);
    const teamBoard = slot ? ownerBoardKey(slot.team, nodeBoard, src.cwdKey) : undefined;
    const knownRefs = new Set([...src.tabs.map((tab) => tab.id), ...src.threads.map((thread) => `thread:${thread.id}`)]);
    const oldFolder = src.boards[folderKey];
    const manualLegacyLink = !slot && !nodeBoard.has(base.ref) && oldFolder?.edges.some((edge) =>
      (edge.a === base.ref && knownRefs.has(edge.b)) || (edge.b === base.ref && knownRefs.has(edge.a)));
    const ownBoard = nodeBoard.get(base.ref);
    const ownSpecial = ownBoard && isLegacySpecialKey(ownBoard) ? ownBoard : undefined;
    const boardKey = ownSpecial || teamBoard || ownBoard || (manualLegacyLink ? folderKey : `${folderKey}#s:${base.ref}`);
    const missionId = slot?.team.missionId || missionOfKey(boardKey) || undefined;
    const role = slot?.member?.role || nodeBoardRole(src.boards, boardKey, base.ref)
      || nodeBoardRole(src.boards, (src.cwdKey ?? ((cwd) => `main|${cwd}`))(base.cwd), base.ref);
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
    .map((t) => build({ ref: threadKey(t.id), kind: "protocol", agentId: t.agentId, cwd: t.cwd, title: t.title, parentRef: t.parentRef || undefined, starting: false, openedAt: t.updatedAt }));
  const all = [...threads, ...tabs];
  const byRef = new Map(all.map((c) => [c.ref, c]));
  const inheritBoard = (conv: UnifiedConversation, visited = new Set<string>()): string | undefined => {
    if (!conv.parentRef || conv.teamId || nodeBoard.has(conv.ref) || visited.has(conv.ref)) return conv.boardKey;
    visited.add(conv.ref);
    const parent = byRef.get(conv.parentRef);
    return parent ? inheritBoard(parent, visited) : conv.boardKey;
  };
  for (const conv of all) {
    if (!conv.parentRef || conv.teamId || nodeBoard.has(conv.ref)) continue;
    const inherited = inheritBoard(conv);
    if (inherited) {
      conv.boardKey = inherited;
      conv.missionId = conv.missionId ?? missionOfKey(inherited);
    }
  }
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

/** O canvas da coroa é o dono; time vindo de um grupo manual mantém a chave de origem. */
function ownerBoardKey(team: TeamView, nodeBoard: Map<string, string>, cwdKey?: (cwd: string) => string): string | undefined {
  const stored = team.boardKey || undefined;
  if (stored && isLegacySpecialKey(stored)) return stored;
  const leadBoard = nodeBoard.get(team.orchestrator);
  if (leadBoard && isLegacySpecialKey(leadBoard)) return leadBoard;
  if (team.origin === "canvas" && stored && !stored.includes("#s:")) return stored;
  if (leadBoard) return leadBoard;
  if (stored?.includes("#s:")) return stored;
  return `${stored ?? (cwdKey ?? ((cwd) => `main|${cwd}`))(team.cwd)}#s:${team.orchestrator}`;
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
