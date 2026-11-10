/**
 * O aviso de uma gravação do log de execução que falhou de vez. O backend manda o sinal `cc-harness-log-failed` à
 * janela (`runs/execution_log.rs`, `fail_write`) e grava a falha em `harness_log_failure`. Esta tela mostra só as
 * falhas de conversa: a falha de tarefa da Frota não tem onde aparecer no chat.
 */
export interface LogFailure {
  /** A chave de dispensa: o `failureId` do registro, ou a assinatura do aviso quando o registro também falhou. */
  key: string;
  threadId: string;
  eventType: string;
  /** O motivo já sanitizado pelo backend (uma linha, sem aparência de segredo). */
  error: string;
  attempts: number;
}

const MAX_REASON_CHARS = 200;

/** Lê o sinal da janela. Sem conversa (o sinal de tarefa da Frota), não há aviso para esta tela. */
export function parseLogFailure(raw: unknown): LogFailure | null {
  if (!raw || typeof raw !== "object") return null;
  const signal = raw as Record<string, unknown>;
  const threadId = typeof signal.threadId === "string" && signal.threadId !== "" ? signal.threadId : null;
  if (threadId === null) return null;
  const eventType = typeof signal.eventType === "string" ? signal.eventType : "";
  const error = typeof signal.error === "string" ? signal.error : "";
  const attempts = typeof signal.attempts === "number" && Number.isFinite(signal.attempts) ? signal.attempts : 0;
  const failureId = typeof signal.failureId === "number" && Number.isFinite(signal.failureId) ? signal.failureId : null;
  const key = failureId !== null ? `id:${failureId}` : `sig:${threadId}|${eventType}|${error}|${attempts}`;
  return { key, threadId, eventType, error, attempts };
}

/** Acrescenta o aviso à lista, sem repetir a mesma chave. */
export function addLogFailure(list: readonly LogFailure[], failure: LogFailure): LogFailure[] {
  return list.some((item) => item.key === failure.key) ? [...list] : [...list, failure];
}

/** Tira da lista o aviso que a pessoa dispensou. */
export function dismissLogFailure(list: readonly LogFailure[], key: string): LogFailure[] {
  return list.filter((item) => item.key !== key);
}

/** O motivo como uma linha só, com no máximo 200 caracteres. */
export function logFailureReason(error: string): string {
  const flat = error.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 1)}…` : flat;
}
