/**
 * O time no canvas: a coroa no orquestrador, a corda até cada integrante e o papel no nó. É isso que
 * autoriza o `ags peer tell/ask` entre eles (o backend lê as cordas, `canvas/mod.rs::reachable`): o
 * time não abre outro canal, cria as mesmas ligações de uma missão.
 *
 * As abas e conversas por protocolo do time aparecem no canvas do orquestrador, com cartões e cordas.
 * Canvases especiais legados preservam seus membros e arestas. Para um canvas de sessão, o integrante é
 * MOVIDO com as cordas, a coroa e o papel (`migrate`, ver `moveSessionArtifacts`): uma cópia deixada para trás
 * continuaria autorizando no backend depois de a corda ser cortada no canvas do time.
 *
 * `canvasPlan` é puro (os testes leem o plano); `applyTeamCanvas` executa com o `canvasActions`.
 */
import { emptyBoard, moveSessionArtifacts, type Board } from "@/features/canvas/board";

import type { TeamView } from "./ipc";
import { isThreadRef } from "./teamModel";

export type CanvasOp =
  | { kind: "crown"; key: string; id: string }
  | { kind: "uncrown"; key: string; id: string }
  | { kind: "move"; from: string; to: string; ids: string[] }
  | { kind: "migrate"; from: string; to: string; ids: string[] }
  | { kind: "connect"; key: string; a: string; b: string }
  | { kind: "disconnect"; key: string; a: string; b: string }
  | { kind: "role"; key: string; id: string; label: string; subagent: boolean };

export interface CanvasInput {
  team: TeamView;
  boards: Record<string, Board>;
  /** A chave do canvas de uma aba aberta (`boardKeyOfTab`), ou `null` se ela não está aberta. */
  keyOfTab: (ref: string) => string | null;
  /** O canvas atual da ref, antes de aplicar o canvas da equipe: de onde ela é movida. */
  sourceKeyOfRef?: (ref: string) => string | null;
  /** A chave do canvas de uma pasta (`boardKey`). */
  folderKey: (cwd: string) => string;
  /** O nome do papel no nó. */
  roleLabel: (role: string) => string;
  /** Quem saiu do time: a corda dele com o orquestrador sai. */
  removed?: string[];
  /** O time foi desfeito: saem as cordas e a coroa. */
  dissolve?: boolean;
}

const MISSION_SEP = "#m:";

function hasEdge(board: Board | undefined, a: string, b: string): boolean {
  return !!board?.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
}

/** Os canvases que têm a corda `a`–`b`. */
function keysWithEdge(boards: Record<string, Board>, a: string, b: string): string[] {
  return Object.entries(boards).filter(([, board]) => hasEdge(board, a, b)).map(([key]) => key);
}

/** Onde mora a corda do time: o canvas especial existente ou a sessão do orquestrador. Pura. */
export function leadBoardKey(input: Pick<CanvasInput, "team" | "boards" | "keyOfTab" | "folderKey">): string {
  const { team } = input;
  const stored = team.boardKey || "";
  const own = !isThreadRef(team.orchestrator) ? input.keyOfTab(team.orchestrator) : null;
  const separators = ["#m:", "#c:", "#cmp:"];
  const specialBoard = Object.entries(input.boards).find(([key, board]) => separators.some((sep) => key.includes(sep))
    && (team.orchestrator in board.nodes || team.orchestrator in board.threads))?.[0];
  if (specialBoard) return specialBoard;
  const storedSpecial = separators.some((sep) => stored.includes(sep)) ? stored : null;
  if (storedSpecial) return storedSpecial;
  if (team.origin === "canvas" && stored && !stored.includes("#s:")) return stored;
  if (own?.includes("#s:")) return own;
  const existingSession = Object.entries(input.boards).find(([key, board]) => key.includes("#s:")
    && (team.orchestrator in board.nodes || team.orchestrator in board.threads))?.[0];
  if (existingSession) return existingSession;
  if (isThreadRef(team.orchestrator)) {
    return stored.includes("#s:") ? stored : `${stored || input.folderKey(team.cwd)}#s:${team.orchestrator}`;
  }
  return `${stored && !stored.includes("#s:") ? stored : own || input.folderKey(team.cwd)}#s:${team.orchestrator}`;
}

/** O que mudar no canvas para ele refletir o time. Vazio = já está certo. Pura. */
export function canvasPlan(input: CanvasInput): CanvasOp[] {
  const { team, boards } = input;
  const lead = team.orchestrator;
  const leadKey = leadBoardKey(input);
  const ops: CanvasOp[] = [];
  // Sem orquestrador (a coroa saiu do canvas): o time continua no chat e o canvas fica como a pessoa deixou.
  if (!lead) return ops;
  const disconnectAll = (ref: string) => {
    for (const key of keysWithEdge(boards, lead, ref)) ops.push({ kind: "disconnect", key, a: lead, b: ref });
  };

  // O orquestrador é uma aba que ainda não abriu (o app subindo): nada a fazer até ela aparecer.
  if (!isThreadRef(lead) && input.keyOfTab(lead) === null && !input.dissolve && !input.removed?.length) return ops;

  if (input.dissolve) {
    for (const m of team.members) disconnectAll(m.member);
    for (const [key, board] of Object.entries(boards)) if (board.orchestrators.includes(lead)) ops.push({ kind: "uncrown", key, id: lead });
    return ops;
  }

  const leadBoard = boards[leadKey] ?? emptyBoard();
  const leadSourceKey = input.sourceKeyOfRef?.(lead) ?? (isThreadRef(lead) ? input.folderKey(team.cwd) : input.keyOfTab(lead));
  const leadSource = leadSourceKey ? boards[leadSourceKey] : undefined;
  if (leadSourceKey && leadSourceKey !== leadKey && leadKey.includes("#s:") && leadSource
    && moveSessionArtifacts(leadSource, leadBoard, lead).source !== leadSource) {
    ops.push({ kind: "migrate", from: leadSourceKey, to: leadKey, ids: [lead] });
  }
  if (!Object.values(boards).some((b) => b.orchestrators.includes(lead))) ops.push({ kind: "crown", key: leadKey, id: lead });

  for (const m of team.members) {
    const ref = m.member;
    let nodeKey = leadKey;
    const sourceKey = input.sourceKeyOfRef?.(ref) ?? (!isThreadRef(ref) ? input.keyOfTab(ref) : null);
    const sourceBoard = sourceKey ? boards[sourceKey] : undefined;
    const specialSource = !!sourceKey && [MISSION_SEP, "#c:", "#cmp:"].some((sep) => sourceKey.includes(sep));
    if (isThreadRef(ref) && sourceKey && sourceKey !== leadKey && leadKey.includes("#s:") && sourceBoard && !specialSource
      && moveSessionArtifacts(sourceBoard, leadBoard, ref).source !== sourceBoard) {
      ops.push({ kind: "migrate", from: sourceKey, to: leadKey, ids: [ref] });
    }
    if (!isThreadRef(ref)) {
      const own = input.keyOfTab(ref);
      // Aba fechada: sem nó nem corda (o `reconcile` tiraria). Volta quando ela abrir.
      if (own === null) continue;
      // Junto do orquestrador, para o canvas mostrar o time. Quem é de uma missão fica nela.
      const source = sourceKey ?? own;
      const special = [MISSION_SEP, "#c:", "#cmp:"].some((sep) => own.includes(sep) || source.includes(sep));
      const sourceBoard = boards[source];
      const canMigrate = !!sourceBoard && moveSessionArtifacts(sourceBoard, leadBoard, ref).source !== sourceBoard;
      if (!special && source !== leadKey && canMigrate) {
        if (leadKey.includes("#s:")) ops.push({ kind: "migrate", from: source, to: leadKey, ids: [ref] });
        else ops.push({ kind: "move", from: source, to: leadKey, ids: [ref] });
        nodeKey = leadKey;
      } else nodeKey = special ? own : leadKey;
    }
    const linked = hasEdge(leadBoard, lead, ref) || (nodeKey !== leadKey && hasEdge(boards[nodeKey], lead, ref))
      || ops.some((op) => (op.kind === "move" || op.kind === "migrate") && op.ids.includes(ref) && hasEdge(boards[op.from], lead, ref));
    if (!linked) ops.push({ kind: "connect", key: leadKey, a: lead, b: ref });
    const label = input.roleLabel(m.role);
    const current = boards[nodeKey]?.roles[ref] ?? boards[leadKey]?.roles[ref];
    const markedNow = boards[nodeKey]?.subagents.includes(ref) ?? boards[leadKey]?.subagents.includes(ref) ?? false;
    const subagent = m.subagent;
    if ((label && current !== label) || subagent !== markedNow) ops.push({ kind: "role", key: nodeKey, id: ref, label: label || current || "", subagent });
  }

  for (const ref of input.removed ?? []) {
    if (!team.members.some((m) => m.member === ref)) disconnectAll(ref);
  }
  return ops;
}

/** As ações do canvas que o plano usa (o `canvasActions` de verdade, ou um falso nos testes). */
export interface CanvasApi {
  boards: () => Record<string, Board>;
  connect: (key: string, a: string, b: string) => void;
  disconnectPair: (key: string, a: string, b: string) => void;
  toggleOrchestrator: (key: string, id: string) => void;
  moveTerminals: (from: string, to: string, ids: string[]) => void;
  migrateSession: (from: string, to: string, id: string) => void;
  setRole: (key: string, id: string, role: string | null, subagent: boolean) => void;
}

/** Executa o plano e devolve os canvases mexidos (para gravar já). */
export function runCanvasPlan(ops: CanvasOp[], api: CanvasApi): string[] {
  const touched = new Set<string>();
  for (const op of ops) {
    switch (op.kind) {
      case "crown":
      case "uncrown": {
        const on = api.boards()[op.key]?.orchestrators.includes(op.id) ?? false;
        if ((op.kind === "crown") !== on) api.toggleOrchestrator(op.key, op.id);
        touched.add(op.key);
        break;
      }
      case "move":
        api.moveTerminals(op.from, op.to, op.ids);
        touched.add(op.from).add(op.to);
        break;
      case "migrate":
        for (const id of op.ids) api.migrateSession(op.from, op.to, id);
        touched.add(op.from).add(op.to);
        break;
      case "connect":
        api.connect(op.key, op.a, op.b);
        touched.add(op.key);
        break;
      case "disconnect":
        // Corta em TODO canvas que tiver a corda agora, não só no do plano: um `migrate` anterior pode tê-la levado
        // para outro, e o backend autoriza por corda em qualquer canvas.
        for (const key of new Set([op.key, ...keysWithEdge(api.boards(), op.a, op.b)])) {
          api.disconnectPair(key, op.a, op.b);
          touched.add(key);
        }
        break;
      case "role":
        api.setRole(op.key, op.id, op.label || null, op.subagent);
        touched.add(op.key);
        break;
    }
  }
  return [...touched];
}
