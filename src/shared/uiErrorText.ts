/** Mensagem para toast/banner: Object com `message` não pode virar "[object Object]". */
export function uiErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    if ("message" in error) {
      const message = (error as { message: unknown }).message;
      if (message != null && String(message) !== "") return String(message);
    }
    if ("kind" in error) {
      const kind = (error as { kind: unknown }).kind;
      if (kind != null && String(kind) !== "") return String(kind);
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json.length > 200 ? json.slice(0, 200) : json;
    } catch {
      /* cíclico ou não serializável */
    }
  }
  return String(error);
}
