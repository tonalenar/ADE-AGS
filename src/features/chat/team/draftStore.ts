import { create } from "zustand";

import { addDraftMember, removeDraftMember, updateDraftMember, type DraftMember } from "./teamDraft";

/**
 * O time da tela "Nova conversa": quem o orquestrador (o agente do composer) terá ao nascer. Fica só na
 * memória e some ao descartar a tela ou depois de criar; nada vai ao backend antes de enviar a
 * primeira mensagem (`teamLaunch.ts`).
 */

/** O orquestrador em formação: o que o composer escolheu. */
export interface DraftLead {
  agentId: string;
  label: string;
  cwd: string;
}

interface DraftState {
  lead: DraftLead | null;
  members: DraftMember[];
  /** O formulário "Ligar agente" aberto. */
  adding: boolean;
  /** O integrante em edição (o mesmo formulário, já preenchido). */
  editing: string | null;
}

const EMPTY: DraftState = { lead: null, members: [], adding: false, editing: null };

export const useTeamDraft = create<DraftState>(() => EMPTY);

/** O composer publica o orquestrador a cada troca de agente ou pasta (sem mudar nada, não notifica). */
export function setDraftLead(lead: DraftLead | null): void {
  const cur = useTeamDraft.getState().lead;
  if (cur === lead || (cur && lead && cur.agentId === lead.agentId && cur.label === lead.label && cur.cwd === lead.cwd)) return;
  useTeamDraft.setState({ lead });
}

let seq = 0;
export const newDraftId = (): string => `draft-${++seq}`;

export function addToDraft(member: DraftMember): void {
  useTeamDraft.setState((s) => ({ members: addDraftMember(s.members, member), adding: false }));
}

export function updateInDraft(id: string, patch: Partial<DraftMember>): void {
  useTeamDraft.setState((s) => ({ members: updateDraftMember(s.members, id, patch), editing: null }));
}

export function removeFromDraft(id: string): void {
  useTeamDraft.setState((s) => ({ members: removeDraftMember(s.members, id), editing: s.editing === id ? null : s.editing }));
}

export function setDraftForm(form: { adding?: boolean; editing?: string | null }): void {
  useTeamDraft.setState((s) => ({ adding: form.adding ?? s.adding, editing: form.editing === undefined ? s.editing : form.editing }));
}

/** Descarta o rascunho (sai da tela ou o time foi criado). */
export function clearDraft(): void {
  if (useTeamDraft.getState() !== EMPTY) useTeamDraft.setState(EMPTY);
}
