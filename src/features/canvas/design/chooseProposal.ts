import { AlertaToast } from "@/shared/ui/alerts";
import type { TFunction } from "i18next";

import { untrustedInline } from "@/shared/untrusted";

import { designApi, type Artboard, type Design } from "./designApi";

/** Escolhas em andamento ou recém-enviadas (`prancheta|seletor`): um duplo clique ou reenvio não manda de novo. */
const recent = new Map<string, number>();
export const CHOOSE_DEDUPE_MS = 4000;

/** Reserva a escolha; `false` se a mesma já foi feita há pouco (ou está em andamento). Pura em relação ao tempo passado. */
export function claimChoice(key: string, now = Date.now()): boolean {
  const at = recent.get(key);
  if (at !== undefined && now - at < CHOOSE_DEDUPE_MS) return false;
  recent.set(key, now);
  return true;
}
export const releaseChoice = (key: string) => { recent.delete(key); };

/**
 * A mensagem que o dono recebe quando a pessoa escolhe uma proposta. Título da prancheta, do design, a proposta e o
 * seletor vêm do HTML do agente: entram como dado numa linha só (um `tellOwner` com quebra enviaria antes do fim). Pura.
 */
export function choiceForOwner(args: { designTitle: string; boardTitle: string; boardId: string; what: string; selector: string }): string {
  const { designTitle, boardTitle, boardId, what, selector } = args;
  return `Design ${untrustedInline("título do design", designTitle)}: o usuário ESCOLHEU na prancheta ${untrustedInline("título da prancheta", boardTitle)} (id ${boardId}) a proposta ${untrustedInline("proposta escolhida", what)} [${untrustedInline("seletor", selector)}]. A prancheta foi APROVADA com essa escolha: construa SOMENTE essa proposta (as outras estão descartadas).`;
}

/**
 * O usuário clicou na proposta que escolhe numa prancheta com várias: registra o comentário, aprova a
 * prancheta e avisa o dono do design (se houver). Compartilhada pelo canvas e pelo modo de foco. A
 * escolha só segue uma vez; sem dono (aba fechada) ela é registrada e só se avisa que ninguém recebeu.
 */
export async function chooseOnBoard(args: {
  t: TFunction; board: Artboard; design: Pick<Design, "title">; owner: string | null;
  pick: { selector: string; text: string }; reload: () => void | Promise<void>;
}): Promise<void> {
  const { t, board, design, owner, pick, reload } = args;
  const what = pick.text || pick.selector;
  const key = `${board.id}|${pick.selector}`;
  if (!claimChoice(key)) return;
  let repeated = false;
  try {
    const added = await designApi.addComment(board.id, t("canvas.design.chosenComment", { what }), pick.selector);
    repeated = added.commentAdded === false;
    await designApi.approve(board.id);
    await reload();
  } catch (e) {
    releaseChoice(key); // não gravou: o usuário pode tentar de novo
    AlertaToast(t("canvas.design.title"), String(e), "error", 6000);
    return;
  }
  if (repeated) return; // a mesma escolha já foi registrada (e enviada) antes: não reenvia ao dono
  if (!owner) {
    AlertaToast(t("canvas.design.title"), t("canvas.design.noOwner"), "warning", 6000);
    return;
  }
  try {
    await designApi.tellOwner(owner, choiceForOwner({ designTitle: design.title, boardTitle: board.title, boardId: board.id, what, selector: pick.selector }));
    AlertaToast(t("canvas.design.title"), t("canvas.design.chosen", { what }), "success", 4000);
  } catch {
    // A escolha já está gravada; só não chegou ao dono (aba fechada, por exemplo).
    AlertaToast(t("canvas.design.title"), t("canvas.design.noOwner"), "warning", 6000);
  }
}
