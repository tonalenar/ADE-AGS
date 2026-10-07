export const SECRET_CONFIRMATION_CODE = "CONFIRMACAO_DE_CREDENCIAL";

export function errorText(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object" && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

/** O backend usa o mesmo código na proposta e na aprovação. */
export function needsSecretConfirmation(cause: unknown): boolean {
  return errorText(cause).includes(SECRET_CONFIRMATION_CODE);
}
