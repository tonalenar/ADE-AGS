import { AlertaToast } from "neogestify-ui-components";
import type { TFunction } from "i18next";

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
  try {
    await designApi.addComment(board.id, t("canvas.design.chosenComment", { what }), pick.selector);
    await designApi.approve(board.id);
    await reload();
  } catch (e) {
    releaseChoice(key); // não gravou: o usuário pode tentar de novo
    AlertaToast(t("canvas.design.title"), String(e), "error", 6000);
    return;
  }
  if (!owner) {
    AlertaToast(t("canvas.design.title"), t("canvas.design.noOwner"), "warning", 6000);
    return;
  }
  try {
    await designApi.tellOwner(owner, `Design "${design.title}": o usuário ESCOLHEU na prancheta "${board.title}" (id ${board.id}) a proposta "${what}" [${pick.selector}]. A prancheta foi APROVADA com essa escolha: construa SOMENTE essa proposta (as outras estão descartadas).`);
    AlertaToast(t("canvas.design.title"), t("canvas.design.chosen", { what }), "success", 4000);
  } catch {
    // A escolha já está gravada; só não chegou ao dono (aba fechada, por exemplo).
    AlertaToast(t("canvas.design.title"), t("canvas.design.noOwner"), "warning", 6000);
  }
}
