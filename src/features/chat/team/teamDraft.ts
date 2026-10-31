/**
 * O time montado ANTES da conversa (rascunho) e a criação dele ao enviar a primeira mensagem. Sem React
 * e sem `invoke`: a criação fala com o mundo por um `TeamPort` (o de verdade está em `teamLaunch.ts`),
 * o que deixa a ordem das etapas e o desfazer em falha testáveis.
 */
import type { AgentInfo } from "@/features/tabs/types";

import type { TeamPolicy } from "./ipc";
import type { ConversationRef } from "./teamStore";

/** Um integrante do rascunho: uma conversa NOVA de um agente, ou uma conversa já aberta. */
export type DraftMember = {
  /** O id só do rascunho (não existe no backend). */
  id: string;
  role: string;
  policy: TeamPolicy;
  subagent: boolean;
} & (
  | { kind: "new"; agent: AgentInfo; model: string | null; effort: string | null; worktree: boolean }
  | { kind: "existing"; conv: ConversationRef }
);

export const addDraftMember = (list: DraftMember[], member: DraftMember): DraftMember[] => [...list, member];

export const removeDraftMember = (list: DraftMember[], id: string): DraftMember[] => list.filter((m) => m.id !== id);

export const updateDraftMember = (list: DraftMember[], id: string, patch: Partial<DraftMember>): DraftMember[] =>
  list.map((m) => (m.id === id ? ({ ...m, ...patch } as DraftMember) : m));

/** Como o integrante aparece na lista: o agente (conversa nova) ou o título (conversa aberta). */
export const draftMemberName = (member: DraftMember): string => (member.kind === "new" ? member.agent.label : member.conv.title);

// ── A criação ────────────────────────────────────────────────────────

/** Algo criado nesta tentativa, com o jeito de desfazer. */
export interface Created {
  /** A chave da conversa (`tab` ou `thread:<id>`) ou, no time, a do orquestrador. */
  ref: string;
  undo: () => Promise<void>;
  /** O que dizer se não der para desfazer. */
  describe?: string;
  /** O que fica mesmo desfeito (um worktree no disco: nada o apaga sozinho). */
  keeps?: string;
}

/** O que a criação precisa do app, em passos pequenos. Cada passo que cria devolve como desfazer. */
export interface TeamPort {
  /** A conversa do orquestrador, SEM enviar a mensagem e sem trocar a tela (o texto continua na caixa). */
  createLead: () => Promise<Created>;
  /** Torna a conversa orquestradora (cria o time). `ref` do resultado = o id do time. */
  makeTeam: (lead: Created) => Promise<Created>;
  /** Abre (se nova) e liga o integrante, com o briefing dele. */
  linkMember: (teamId: string, member: DraftMember) => Promise<Created>;
  /** Entrega a mensagem inicial ao orquestrador com o aviso de elenco e mostra a conversa. Última etapa. */
  deliver: (lead: Created, teamId: string) => void;
}

export type LaunchResult =
  | { ok: true; ref: string; teamId: string }
  /** `leftovers`: o que ficou e a pessoa precisa saber (não deu para desfazer). */
  | { ok: false; error: string; leftovers: string[] };

let launching = false;

/**
 * Cria a conversa, torna-a orquestradora, liga cada integrante e entrega a mensagem, nessa ordem. Se uma
 * etapa falhar, desfaz o que ESTA tentativa criou, do último ao primeiro, e devolve o erro; o rascunho
 * e o texto ficam com quem chamou. Desfazer nunca apaga nada além do criado agora (um worktree, por
 * exemplo, fica no disco e vem em `leftovers`). Uma criação por vez.
 */
export async function launchTeam(port: TeamPort, members: DraftMember[]): Promise<LaunchResult> {
  if (launching) return { ok: false, error: "já está criando", leftovers: [] };
  launching = true;
  const done: Created[] = [];
  try {
    const lead = await port.createLead();
    done.push(lead);
    const team = await port.makeTeam(lead);
    done.push(team);
    for (const member of members) done.push(await port.linkMember(team.ref, member));
    port.deliver(lead, team.ref);
    return { ok: true, ref: lead.ref, teamId: team.ref };
  } catch (e) {
    const leftovers: string[] = [];
    // Uma etapa que falhou no meio pode ter deixado um worktree (o erro leva a nota).
    const partial = (e as { keeps?: string } | null)?.keeps;
    if (partial) leftovers.push(partial);
    for (const created of done.reverse()) {
      try {
        await created.undo();
        if (created.keeps) leftovers.push(created.keeps);
      } catch {
        leftovers.push(created.describe ?? created.ref);
      }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), leftovers };
  } finally {
    launching = false;
  }
}
