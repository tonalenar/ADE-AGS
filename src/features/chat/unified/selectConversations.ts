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

const defaultCwdKey = (cwd: string) => `main|${cwd}`;

function sameConversation(a: UnifiedConversation, b: UnifiedConversation): boolean {
  return a.ref === b.ref
    && a.kind === b.kind
    && a.agentId === b.agentId
    && a.cwd === b.cwd
    && a.title === b.title
    && a.teamId === b.teamId
    && a.role === b.role
    && a.boardKey === b.boardKey
    && a.missionId === b.missionId
    && a.origin === b.origin
    && a.lead === b.lead
    && a.subagent === b.subagent
    && a.parentRef === b.parentRef
    && a.starting === b.starting
    && a.openedAt === b.openedAt;
}

function sameConversations(a: UnifiedConversation[], b: UnifiedConversation[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameConversation(a[i]!, b[i]!)) return false;
  }
  return true;
}

interface CachedSelection {
  tabs: UnifiedSources["tabs"];
  threads: UnifiedSources["threads"];
  teams: UnifiedSources["teams"];
  boards: UnifiedSources["boards"];
  result: UnifiedConversation[];
}

// Cache compartilhado no módulo (indexado por `cwdKey`): os vários hooks `useConversations()`
// que leem as mesmas 4 fontes reaproveitam o mesmo cálculo e a mesma referência de array.
const cacheByCwdKey = new WeakMap<(cwd: string) => string, CachedSelection>();
let defaultCache: CachedSelection | null = null;

/** O canvas onde a ref é um nó: o especial (missão, projeto, comparação) vence o da pasta. */
function boardKeyByNode(boards: UnifiedSources["boards"]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, board] of Object.entries(boards)) {
    if (!CANVAS_SCOPE_SEPS.some((sep) => key.includes(sep))) continue;
    const keyIsLegacy = isLegacySpecialKey(key);
    for (const ref of Object.keys(board.nodes)) {
      const have = out.get(ref);
      if (!have || (keyIsLegacy && !isLegacySpecialKey(have))) out.set(ref, key);
    }
    if (board.threads) {
      for (const ref of Object.keys(board.threads)) {
        const have = out.get(ref);
        if (!have || (keyIsLegacy && !isLegacySpecialKey(have))) out.set(ref, key);
      }
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

function computeConversations(src: UnifiedSources, resolveCwdKey: (cwd: string) => string): UnifiedConversation[] {
  const slots = teamSlots(src.teams);
  const nodeBoard = boardKeyByNode(src.boards);
  // Içado para fora de `build`: O(N) uma única vez em vez de recriar o Set por conversa (O(N²)).
  const knownRefs = new Set<string>();
  for (const tab of src.tabs) knownRefs.add(tab.id);
  for (const thread of src.threads) knownRefs.add(threadKey(thread.id));

  // Índice preguiçoso por pasta das refs com aresta legada para outra conversa conhecida (O(E) uma vez por pasta).
  const legacyLinkedByFolder = new Map<string, Set<string>>();
  const hasManualLegacyLink = (folderKey: string, ref: string): boolean => {
    let linked = legacyLinkedByFolder.get(folderKey);
    if (!linked) {
      linked = new Set<string>();
      const edges = src.boards[folderKey]?.edges;
      if (edges) {
        for (const edge of edges) {
          if (knownRefs.has(edge.b)) linked.add(edge.a);
          if (knownRefs.has(edge.a)) linked.add(edge.b);
        }
      }
      legacyLinkedByFolder.set(folderKey, linked);
    }
    return linked.has(ref);
  };

  const build = (base: Pick<UnifiedConversation, "ref" | "kind" | "agentId" | "cwd" | "title" | "parentRef" | "starting" | "openedAt">): UnifiedConversation => {
    const slot = slots.get(base.ref);
    const folderKey = resolveCwdKey(base.cwd);
    const teamBoard = slot ? ownerBoardKey(slot.team, nodeBoard, resolveCwdKey) : undefined;
    const ownBoard = nodeBoard.get(base.ref);
    const manualLegacyLink = !slot && !ownBoard && hasManualLegacyLink(folderKey, base.ref);
    const ownSpecial = ownBoard && isLegacySpecialKey(ownBoard) ? ownBoard : undefined;
    const boardKey = ownSpecial || teamBoard || ownBoard || (manualLegacyLink ? folderKey : `${folderKey}#s:${base.ref}`);
    const missionId = slot?.team.missionId || missionOfKey(boardKey) || undefined;
    const role = slot?.member?.role || nodeBoardRole(src.boards, boardKey, base.ref)
      || nodeBoardRole(src.boards, folderKey, base.ref);
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

  const all: UnifiedConversation[] = [];
  for (const t of src.threads) {
    if (t.state === "active") {
      all.push(build({ ref: threadKey(t.id), kind: "protocol", agentId: t.agentId, cwd: t.cwd, title: t.title, parentRef: t.parentRef || undefined, starting: false, openedAt: t.updatedAt }));
    }
  }
  for (const t of src.tabs) {
    if (t.agentId !== SHELL_AGENT_ID) {
      all.push(build({ ref: t.id, kind: "pty", agentId: t.agentId, cwd: t.cwd, title: t.title, starting: t.ptyId == null, openedAt: t.openedAt }));
    }
  }
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

/** Todas as conversas abertas, a mais recente primeiro. Aba de shell não é conversa; protocolo só se ativa. */
export function selectConversations(src: UnifiedSources): UnifiedConversation[] {
  const cached = src.cwdKey ? cacheByCwdKey.get(src.cwdKey) : defaultCache;
  if (
    cached
    && cached.tabs === src.tabs
    && cached.threads === src.threads
    && cached.teams === src.teams
    && cached.boards === src.boards
  ) {
    return cached.result;
  }

  const next = computeConversations(src, src.cwdKey ?? defaultCwdKey);
  const result = cached && sameConversations(cached.result, next) ? cached.result : next;
  const entry: CachedSelection = {
    tabs: src.tabs,
    threads: src.threads,
    teams: src.teams,
    boards: src.boards,
    result,
  };
  if (src.cwdKey) cacheByCwdKey.set(src.cwdKey, entry);
  else defaultCache = entry;
  return result;
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
