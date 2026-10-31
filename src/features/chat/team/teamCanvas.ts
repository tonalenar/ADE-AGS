/**
 * O time no canvas: a coroa no orquestrador, a corda até cada integrante e o papel no nó. É isso que
 * autoriza o `ags peer tell/ask` entre eles (o backend lê as cordas, `canvas/mod.rs::reachable`): o
 * time não abre outro canal, cria as mesmas ligações de uma missão.
 *
 * Abas de agente do time vão para o canvas do orquestrador (quando ele é uma aba), para aparecerem
 * juntas como cartões ligados por cordas. Uma conversa por protocolo não tem nó: a corda dela fica no
 * canvas da pasta (`board.ts::reconcile` a mantém) e vale só para o `peer`.
 *
 * `canvasPlan` é puro (os testes leem o plano); `applyTeamCanvas` executa com o `canvasActions`.
 */
import { emptyBoard, type Board } from "@/features/canvas/board";

import type { TeamView } from "./ipc";
import { isThreadRef } from "./teamModel";

export type CanvasOp =
  | { kind: "crown"; key: string; id: string }
  | { kind: "uncrown"; key: string; id: string }
  | { kind: "move"; from: string; to: string; ids: string[] }
  | { kind: "connect"; key: string; a: string; b: string }
  | { kind: "disconnect"; key: string; a: string; b: string }
  | { kind: "role"; key: string; id: string; label: string; subagent: boolean };

export interface CanvasInput {
  team: TeamView;
  boards: Record<string, Board>;
  /** A chave do canvas de uma aba aberta (`boardKeyOfTab`), ou `null` se ela não está aberta. */
  keyOfTab: (ref: string) => string | null;
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

/** Onde mora a corda do time: o canvas do orquestrador (a aba) ou o da pasta (conversa por protocolo). Pura. */
export function leadBoardKey(input: Pick<CanvasInput, "team" | "keyOfTab" | "folderKey">): string {
  const { team } = input;
  return (!isThreadRef(team.orchestrator) && input.keyOfTab(team.orchestrator)) || input.folderKey(team.cwd);
}

/** O que mudar no canvas para ele refletir o time. Vazio = já está certo. Pura. */
export function canvasPlan(input: CanvasInput): CanvasOp[] {
  const { team, boards } = input;
  const lead = team.orchestrator;
  const leadKey = leadBoardKey(input);
  const ops: CanvasOp[] = [];
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
  if (!Object.values(boards).some((b) => b.orchestrators.includes(lead))) ops.push({ kind: "crown", key: leadKey, id: lead });

  for (const m of team.members) {
    const ref = m.member;
    let nodeKey = leadKey;
    if (!isThreadRef(ref)) {
      const own = input.keyOfTab(ref);
      // Aba fechada: sem nó nem corda (o `reconcile` tiraria). Volta quando ela abrir.
      if (own === null) continue;
      nodeKey = own;
      // Junto do orquestrador, para o canvas mostrar o time. Quem é de uma missão fica nela.
      if (!isThreadRef(lead) && own !== leadKey && !own.includes(MISSION_SEP) && ref in (boards[own]?.nodes ?? {})) {
        ops.push({ kind: "move", from: own, to: leadKey, ids: [ref] });
        nodeKey = leadKey;
      }
    }
    const linked = hasEdge(leadBoard, lead, ref) || (nodeKey !== leadKey && hasEdge(boards[nodeKey], lead, ref))
      || ops.some((op) => op.kind === "move" && op.ids.includes(ref) && hasEdge(boards[op.from], lead, ref));
    if (!linked) ops.push({ kind: "connect", key: leadKey, a: lead, b: ref });
    const label = input.roleLabel(m.role);
    const current = boards[nodeKey]?.roles[ref] ?? boards[leadKey]?.roles[ref];
    const markedNow = boards[nodeKey]?.subagents.includes(ref) ?? boards[leadKey]?.subagents.includes(ref) ?? false;
    // A conversa por protocolo não tem nó: a marca do canvas fica como está (a do time vale só no painel).
    const subagent = isThreadRef(ref) ? markedNow : m.subagent;
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
      case "connect":
        api.connect(op.key, op.a, op.b);
        touched.add(op.key);
        break;
      case "disconnect":
        api.disconnectPair(op.key, op.a, op.b);
        touched.add(op.key);
        break;
      case "role":
        api.setRole(op.key, op.id, op.label || null, op.subagent);
        touched.add(op.key);
        break;
    }
  }
  return [...touched];
}
