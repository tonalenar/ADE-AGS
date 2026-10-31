/**
 * O que a caixa de Permissões precisa saber do time, num módulo puro: de quem é o pedido (papel,
 * política, time) e o que a política decide sozinha. Espelho de `chat_team::model::decide`.
 *
 * Regras:
 * - leitura passa sempre;
 * - só leitura nega edição, comando e rede;
 * - risco alto NUNCA é automático (vai à pessoa; na só leitura, é negado);
 * - acesso total passa o resto; aceita edições passa só edição; supervisionado pergunta tudo.
 *
 * Quem lê: `teamPolicyOf(teams, ref)` com a lista de `useTeamStore.getState().teams` e a chave da
 * conversa do pedido (o id da aba ou `thread:<id>`).
 */
import type { TeamPolicy, TeamView } from "./ipc";
import { placeOf } from "./teamModel";

/** O tipo de pedido, como a caixa classifica. */
export type PermissionKind = "read" | "edit" | "command" | "network";

export type PermissionVerdict = "allow" | "ask" | "deny";

/** O que a política decide sozinha. Pura. */
export function decidePermission(policy: TeamPolicy, kind: PermissionKind, highRisk: boolean): PermissionVerdict {
  if (kind === "read") return "allow";
  if (policy === "read") return "deny";
  if (highRisk) return "ask";
  if (policy === "full") return "allow";
  if (policy === "edits" && kind === "edit") return "allow";
  return "ask";
}

/** De quem é o pedido, no time. `null` = a conversa não está num time. */
export interface TeamRequester {
  teamId: string;
  /** A conversa do orquestrador do time. */
  orchestrator: string;
  /** `orchestrator` ou o id do papel (`frontend`, `qa`…). */
  role: string;
  /** A política do integrante; o orquestrador não tem política no time (`null`: vale o acesso da conversa). */
  policy: TeamPolicy | null;
  label: string;
}

/** Papel, política e time de uma conversa. Pura. */
export function teamRequester(teams: TeamView[], ref: string | null | undefined): TeamRequester | null {
  const place = placeOf(teams, ref);
  if (!place) return null;
  const { team, member } = place;
  return member
    ? { teamId: team.id, orchestrator: team.orchestrator, role: member.role, policy: member.policy, label: member.label }
    : { teamId: team.id, orchestrator: team.orchestrator, role: "orchestrator", policy: null, label: team.label };
}

/** A política do integrante (`null` fora de time ou no orquestrador). Pura. */
export function teamPolicyOf(teams: TeamView[], ref: string | null | undefined): TeamPolicy | null {
  return teamRequester(teams, ref)?.policy ?? null;
}

/**
 * O que fazer com um pedido de uma conversa: a decisão da política do time, ou `null` se a conversa
 * não tem política de time (fora de time, ou o orquestrador: decide a pessoa ou as regras dela). Pura.
 */
export function teamVerdict(teams: TeamView[], ref: string | null | undefined, kind: PermissionKind, highRisk: boolean): PermissionVerdict | null {
  const policy = teamPolicyOf(teams, ref);
  return policy ? decidePermission(policy, kind, highRisk) : null;
}

/**
 * O mesmo, direto do pedido da caixa (`permissions/permissionModel.ts::PendingAsk`, pelo formato): o
 * comando que acessa a rede conta como rede; risco alto é `risk: "high"`. `null` = sem política de time.
 * Pura.
 */
export function teamVerdictForAsk(
  teams: TeamView[],
  ask: { conversation: string | null; kind: "command" | "edit" | "network"; network: boolean; risk: "low" | "medium" | "high" },
): PermissionVerdict | null {
  const kind: PermissionKind = ask.kind === "edit" ? "edit" : ask.kind === "network" || ask.network ? "network" : "command";
  return teamVerdict(teams, ask.conversation, kind, ask.risk === "high");
}
