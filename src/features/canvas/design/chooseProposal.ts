import { AlertaToast } from "neogestify-ui-components";
import type { TFunction } from "i18next";

import { designApi, type Artboard, type Design } from "./designApi";

/**
 * O usuário clicou na proposta que escolhe numa prancheta com várias: registra o comentário, aprova a
 * prancheta e avisa o dono do design (se houver). Compartilhada pelo canvas e pelo modo de foco.
 */
export async function chooseOnBoard(args: {
  t: TFunction; board: Artboard; design: Pick<Design, "title">; owner: string | null;
  pick: { selector: string; text: string }; reload: () => void | Promise<void>;
}): Promise<void> {
  const { t, board, design, owner, pick, reload } = args;
  const what = pick.text || pick.selector;
  try {
    await designApi.addComment(board.id, t("canvas.design.chosenComment", { what }), pick.selector);
    await designApi.approve(board.id);
    await reload();
    if (owner) {
      await designApi.tellOwner(owner, `Design "${design.title}": o usuário ESCOLHEU na prancheta "${board.title}" (id ${board.id}) a proposta "${what}" [${pick.selector}]. A prancheta foi APROVADA com essa escolha: construa SOMENTE essa proposta (as outras estão descartadas).`);
      AlertaToast(t("canvas.design.title"), t("canvas.design.chosen", { what }), "success", 4000);
    } else {
      AlertaToast(t("canvas.design.title"), t("canvas.design.noOwner"), "error", 6000);
    }
  } catch (e) {
    AlertaToast(t("canvas.design.title"), String(e), "error", 6000);
  }
}
