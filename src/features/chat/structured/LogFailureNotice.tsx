import { useTranslation } from "react-i18next";

import { dismissThreadLogFailure, useStructured } from "./store";
import { logFailureReason, type LogFailure } from "./logFailureModel";

const NO_FAILURES: LogFailure[] = [];

/**
 * O aviso discreto de uma gravação do log que falhou nesta conversa. Não é mensagem do chat: some quando a pessoa
 * dispensa. A região de status fica no DOM mesmo vazia, para o leitor de tela anunciar a falha quando ela chegar.
 */
export function LogFailureNotice({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const failures = useStructured((s) => s.logFailures[threadId] ?? NO_FAILURES);
  return (
    <div role="status" aria-atomic="false" className="empty:hidden mb-2 px-1">
      {failures.map((failure) => (
        <div
          key={failure.key}
          className="flex items-start gap-2 rounded-md border border-gray-300 px-2 py-1 text-chat-note text-gray-600 dark:border-gray-700 dark:text-gray-400"
        >
          <p className="min-w-0 flex-1 break-words">
            {t("chat.logFailure.message", { reason: logFailureReason(failure.error) || t("chat.logFailure.noReason") })}
          </p>
          <button
            type="button"
            aria-label={t("chat.logFailure.dismiss")}
            title={t("chat.logFailure.dismiss")}
            onClick={() => dismissThreadLogFailure(threadId, failure.key)}
            className="shrink-0 rounded px-1 leading-none text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
