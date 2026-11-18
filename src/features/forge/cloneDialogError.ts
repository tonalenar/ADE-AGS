/** Mensagem de erro na UI de clonar: ForgeError não pode virar "[object Object]". */
import { forgeErrorOf } from "./types";

export function cloneDialogError(error: unknown): string {
  return forgeErrorOf(error).message;
}
