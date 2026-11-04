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
import { isThreadRef } from "./teamModel";

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
  | { kind: "update"; teamId: string; ref: string; role?: string; subagent?: boolean }
  /** A coroa saiu do canvas: tira SÓ o papel de orquestrador (o time e os integrantes ficam). */
  | { kind: "unlead"; teamId: string };

const MISSION_SEP = "#m:";
const COMPARE_SEP = "#cmp:";

/** O canvas de uma missão (`#m:`) ou de uma comparação (`#cmp:`): outra equipe, fora do espelho do chat. */
const outsideChat = (key: string) => key.includes(MISSION_SEP) || key.includes(COMPARE_SEP);

/**
 * Quem está num canvas de missão (nós e coroas): o time deles é o da missão. O invariante «um agente em um
 * time só» conta também esses (espelho de `canvas::mission_refs`, no Rust). Pura.
 */
export function missionRefsOf(boards: Record<string, Board>): Set<string> {
  const out = new Set<string>();
  for (const [key, board] of Object.entries(boards)) {
    if (!key.includes(MISSION_SEP)) continue;
    for (const id of board.orchestrators) out.add(id);
    for (const id of Object.keys(board.nodes)) out.add(id);
  }
  return out;
}

/** Os canvases em que o orquestrador está coroado (o de missão é de outra equipe e fica de fora). */
function crownedBoards(team: TeamView, boards: Record<string, Board>): Board[] {
  return Object.entries(boards)
    .filter(([key, board]) => !outsideChat(key) && !!team.orchestrator && board.orchestrators.includes(team.orchestrator))
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
  /**
   * A conversa ainda existe (aba aberta ou por protocolo). Fechar a aba leva a coroa junto (`reconcile`):
   * isso não é a pessoa tirando a coroa. Padrão: `isAgentTab` ou `thread:`.
   */
  isOpen?: (ref: string) => boolean;
}

/** O que a pessoa mudou no canvas desde a linha de base, como comandos do time. Pura. */
export function reversePlan(input: ReverseInput): ReverseOp[] {
  const ops: ReverseOp[] = [];
  const taken = new Map<string, string>();
  for (const t of input.teams) {
    if (t.orchestrator) taken.set(t.orchestrator, t.id);
    for (const m of t.members) taken.set(m.member, t.id);
  }
  const inMission = missionRefsOf(input.boards);
  const isOpen = input.isOpen ?? ((ref: string) => isThreadRef(ref) || input.isAgentTab(ref));
  for (const team of input.teams) {
    const base = input.baselines[team.id];
    const now = projectCanvas(team, input.boards, input.isAgentTab);
    if (!base) continue;
    if (!now) {
      // Estava coroado e não está mais, a conversa segue aberta e a coroa não foi para outro canvas: a pessoa a tirou.
      const crownedAnywhere = Object.values(input.boards).some((b) => !!team.orchestrator && b.orchestrators.includes(team.orchestrator));
      if (team.orchestrator && !crownedAnywhere && isOpen(team.orchestrator)) ops.push({ kind: "unlead", teamId: team.id });
      continue;
    }
    for (const [ref, mark] of Object.entries(now)) {
      const before = base[ref];
      const current = team.members.find((m) => m.member === ref);
      if (mark.linked && !before?.linked && !current) {
        // Quem já é de outro time (ou orquestrador dele) fica onde está.
        if (taken.has(ref) && taken.get(ref) !== team.id) continue;
        if (inMission.has(ref)) continue;
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

/** O que o plano sabe de uma conversa (aba de agente ou por protocolo) para montar o time. */
export interface PromoteAgent {
  /** O id da aba ou `thread:<id>`. */
  ref: string;
  agentId: string;
  label: string;
  title: string;
  cwd: string;
}

/** Um time a promover: a coroa de um canvas e os agentes cordados a ela. */
export interface PromoteOp {
  orchestrator: PromoteAgent;
  /** O canvas onde mora a coroa. */
  boardKey: string;
  members: { member: string; agentId: string; label: string; role: string; subagent: boolean }[];
}

/**
 * Coroas do canvas (de pasta ou `#c:`; nunca missão nem comparação) que não lideram nenhum time do chat e têm
 * ao menos uma corda a um agente: viram time (`chat_team_promote`, só linhas no banco). `agents` são as
 * conversas que existem (abas de agente, sem shell, e conversas por protocolo); quem não está nela não conta.
 * Quem já é de outro time com orquestrador, ou de uma missão, fica de fora. `opts.only` limita aos canvases
 * em que a pessoa acabou de mexer (nada de promover canvas antigo sem ela tocar nele). Pura.
 */
export function promotePlan(
  boards: Record<string, Board>,
  teams: TeamView[],
  agents: PromoteAgent[],
  opts: { roleIdOf?: (label: string) => string; only?: Iterable<string> } = {},
): PromoteOp[] {
  const only = opts.only ? new Set(opts.only) : null;
  const byRef = new Map(agents.map((a) => [a.ref, a]));
  const inMission = missionRefsOf(boards);
  const led = new Set(teams.filter((t) => t.orchestrator).map((t) => t.orchestrator));
  const joined = new Set(teams.filter((t) => t.orchestrator).flatMap((t) => t.members.map((m) => m.member)));
  const roleIdOf = opts.roleIdOf ?? ((label: string) => label);
  const ops: PromoteOp[] = [];
  const crownedNow = new Set<string>();
  for (const [key, board] of Object.entries(boards)) {
    if (outsideChat(key) || (only && !only.has(key))) continue;
    for (const lead of board.orchestrators) {
      const orchestrator = byRef.get(lead);
      if (!orchestrator || led.has(lead) || joined.has(lead) || inMission.has(lead) || crownedNow.has(lead)) continue;
      const members: PromoteOp["members"] = [];
      for (const edge of board.edges) {
        const other = edge.a === lead ? edge.b : edge.b === lead ? edge.a : null;
        const agent = other ? byRef.get(other) : undefined;
        if (!other || !agent || other === lead || led.has(other) || joined.has(other) || inMission.has(other)) continue;
        if (board.orchestrators.includes(other) || members.some((m) => m.member === other)) continue;
        const label = board.roles[other];
        members.push({ member: other, agentId: agent.agentId, label: agent.label, role: label ? roleIdOf(label) : "", subagent: board.subagents.includes(other) });
      }
      if (members.length === 0) continue;
      crownedNow.add(lead);
      ops.push({ orchestrator, boardKey: key, members });
    }
  }
  return ops;
}
