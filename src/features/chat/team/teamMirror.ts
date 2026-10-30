/**
 * O sentido canvas -> chat do espelho do time. O sentido chat -> canvas é o `teamCanvas.ts`
 * (`canvasPlan`); aqui o canvas é lido (`projectCanvas`) e o que a PESSOA mudou nele vira comandos do
 * time (`reversePlan`). Tudo puro: o `teamStore` observa o canvas e executa.
 *
 * Para não haver laço, o plano só olha a DIFERENÇA entre o canvas de agora e a linha de base: o canvas
 * como estava quando os dois lados concordaram pela última vez (depois de qualquer sentido ser aplicado
 * a linha de base é adotada de novo). Uma mudança que o próprio time fez no canvas já nasce dentro da
 * linha de base e nunca volta como se fosse da pessoa.
 */
import type { Board } from "@/features/canvas/board";

import type { TeamView } from "./ipc";

/** O que o canvas diz de uma aba em relação ao orquestrador do time. */
export interface CanvasMark {
  /** Há corda entre o orquestrador coroado e a aba. */
  linked: boolean;
  /** O rótulo do papel no nó (`null` = sem especificação). */
  role: string | null;
  subagent: boolean;
}

/** Por aba (id). */
export type CanvasProjection = Record<string, CanvasMark>;

export type ReverseOp =
  | { kind: "link"; teamId: string; ref: string; role: string; subagent: boolean }
  | { kind: "unlink"; teamId: string; ref: string }
  | { kind: "update"; teamId: string; ref: string; role?: string; subagent?: boolean };

const MISSION_SEP = "#m:";

/** Os canvases em que o orquestrador está coroado (o de missão é de outra equipe e fica de fora). */
function crownedBoards(team: TeamView, boards: Record<string, Board>): Board[] {
  return Object.entries(boards)
    .filter(([key, board]) => !key.includes(MISSION_SEP) && board.orchestrators.includes(team.orchestrator))
    .map(([, board]) => board);
}

/**
 * O que o canvas diz do time: as abas de agente ligadas por corda ao orquestrador coroado, com papel e
 * subagente, e os integrantes que são abas abertas sem corda (para perceber que a corda saiu). `null` =
 * o orquestrador não está coroado: o time continua, só deixa de ser espelhado. Pura.
 */
export function projectCanvas(team: TeamView, boards: Record<string, Board>, isAgentTab: (ref: string) => boolean): CanvasProjection | null {
  const crowned = crownedBoards(team, boards);
  if (crowned.length === 0) return null;
  const lead = team.orchestrator;
  const out: CanvasProjection = {};
  for (const board of crowned) {
    for (const edge of board.edges) {
      const other = edge.a === lead ? edge.b : edge.b === lead ? edge.a : null;
      if (!other || other === lead || !isAgentTab(other)) continue;
      const mark = (out[other] ??= { linked: true, role: null, subagent: false });
      mark.role = board.roles[other] ?? mark.role;
      mark.subagent = mark.subagent || board.subagents.includes(other);
    }
  }
  for (const m of team.members) {
    if (!(m.member in out) && isAgentTab(m.member)) out[m.member] = { linked: false, role: null, subagent: false };
  }
  return out;
}

export interface ReverseInput {
  teams: TeamView[];
  boards: Record<string, Board>;
  /** A linha de base de cada time (`teamId`); sem ela o plano não adivinha. */
  baselines: Record<string, CanvasProjection>;
  /** A aba existe e é de um agente (nem shell, nem nota, nem conversa por protocolo). */
  isAgentTab: (ref: string) => boolean;
  /** O id do papel de um rótulo do nó (o rótulo, se não for de um papel do catálogo). */
  roleIdOf: (label: string) => string;
}

/** O que a pessoa mudou no canvas desde a linha de base, como comandos do time. Pura. */
export function reversePlan(input: ReverseInput): ReverseOp[] {
  const ops: ReverseOp[] = [];
  const taken = new Map<string, string>();
  for (const t of input.teams) {
    taken.set(t.orchestrator, t.id);
    for (const m of t.members) taken.set(m.member, t.id);
  }
  for (const team of input.teams) {
    const base = input.baselines[team.id];
    const now = projectCanvas(team, input.boards, input.isAgentTab);
    if (!base || !now) continue;
    for (const [ref, mark] of Object.entries(now)) {
      const before = base[ref];
      const current = team.members.find((m) => m.member === ref);
      if (mark.linked && !before?.linked && !current) {
        // Quem já é de outro time (ou orquestrador dele) fica onde está.
        if (taken.has(ref) && taken.get(ref) !== team.id) continue;
        ops.push({ kind: "link", teamId: team.id, ref, role: mark.role ? input.roleIdOf(mark.role) : "", subagent: mark.subagent });
      } else if (!mark.linked && before?.linked && current) {
        ops.push({ kind: "unlink", teamId: team.id, ref });
      } else if (mark.linked && before?.linked && current) {
        const op: Extract<ReverseOp, { kind: "update" }> = { kind: "update", teamId: team.id, ref };
        const roleId = mark.role ? input.roleIdOf(mark.role) : null;
        if (roleId && mark.role !== before.role && roleId.toLowerCase() !== current.role.toLowerCase()) op.role = roleId;
        if (mark.subagent !== before.subagent && mark.subagent !== current.subagent) op.subagent = mark.subagent;
        if (op.role !== undefined || op.subagent !== undefined) ops.push(op);
      }
    }
  }
  return ops;
}

/** O id do papel do catálogo do time cujo nome (`roleLabel`) é o rótulo do nó; sem par, o próprio rótulo. Pura. */
export function roleIdOfLabel(label: string, roles: readonly string[], roleLabel: (role: string) => string): string {
  const wanted = label.trim().toLowerCase();
  return roles.find((id) => id === wanted || roleLabel(id).trim().toLowerCase() === wanted) ?? label.trim();
}
