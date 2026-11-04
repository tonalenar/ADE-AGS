import type { TeamOrigin } from "@/features/chat/team/ipc";
import { isThreadRef } from "@/features/chat/team/teamModel";
import type { UnifiedConversation } from "@/features/chat/unified/types";

/**
 * O time na vista de Abas, lido do modelo único (`chat/unified`). Puro, sem React nem store: a mesma
 * conta serve a grade, o grupo da barra e o menu de contexto da aba.
 *
 * Todo agente novo nasce com terminal; só o que já nasceu por protocolo (`thread:<id>`) não tem PTY,
 * e por isso aparece como painel de timeline (React puro) em vez de terminal.
 */

export interface TeamGroup {
  teamId: string;
  origin: TeamOrigin;
  /** O orquestrador, ou `null` se a coroa saiu. */
  lead: string | null;
  /** O orquestrador primeiro e depois os integrantes, na ordem recebida. */
  refs: string[];
  /** Os que nasceram por protocolo (sem terminal). */
  protocol: string[];
}

/** Os times com conversa aberta, na ordem em que aparecem. Quem não está em time fica de fora. Pura. */
export function teamGroups(all: UnifiedConversation[]): TeamGroup[] {
  const byTeam = new Map<string, UnifiedConversation[]>();
  for (const c of all) {
    if (!c.teamId) continue;
    byTeam.set(c.teamId, [...(byTeam.get(c.teamId) ?? []), c]);
  }
  return [...byTeam].map(([teamId, mine]) => {
    const head = mine.find((c) => c.lead) ?? null;
    const refs = [...(head ? [head] : []), ...mine.filter((c) => !c.lead)].map((c) => c.ref);
    return {
      teamId,
      origin: mine[0]?.origin ?? "chat",
      lead: head?.ref ?? null,
      refs,
      protocol: refs.filter(isThreadRef),
    };
  });
}

/** As conversas do time da aba ativa (terminais e protocolo), ou `null` se ela não está em time. Pura. */
export function teamGridRefs(all: UnifiedConversation[], activeRef: string | null | undefined): string[] | null {
  const active = activeRef ? all.find((c) => c.ref === activeRef) : undefined;
  if (!active?.teamId) return null;
  return teamGroups(all).find((g) => g.teamId === active.teamId)?.refs ?? null;
}

/** Só as refs que têm terminal: é o que o layout posiciona (nunca uma `thread:`). Pura. */
export function terminalRefs(refs: string[]): string[] {
  return refs.filter((r) => !isThreadRef(r));
}

export type TeamMenuAction = "create" | "link" | "unlink" | "lead" | "unlead";

/**
 * As ações de time do menu de uma aba. `activeTeamId` é o time da aba em foco (onde "ligar" liga).
 * Criar o time torna a aba orquestradora; a coroa só vale para terminal. Pura.
 */
export function teamMenuActions(all: UnifiedConversation[], ref: string, activeTeamId: string | null): TeamMenuAction[] {
  const c = all.find((x) => x.ref === ref);
  if (!c) return [];
  if (!c.teamId) return activeTeamId ? ["create", "link"] : ["create"];
  if (c.lead) return ["unlead"];
  const actions: TeamMenuAction[] = ["unlink"];
  const group = teamGroups(all).find((g) => g.teamId === c.teamId);
  if (group && group.lead === null && !isThreadRef(ref)) actions.push("lead");
  return actions;
}
