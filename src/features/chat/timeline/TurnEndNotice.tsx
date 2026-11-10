import { useTranslation } from "react-i18next";

import { endOutcome, type TurnEnd } from "./timelineModel";

/**
 * O aviso de um turno que não acabou bem: o motivo que o `turnEnd` gravou (erro do agente, processo que
 * caiu) ou um aviso discreto de interrupção (com a razão se houver). Fica no fio da conversa.
 */
export function TurnEndNotice({ end }: { end: TurnEnd }) {
  const { t } = useTranslation();
  const outcome = endOutcome(end);
  if (outcome === "error") {
    return (
      <p role="alert" className="m-0 px-1 text-chat-note text-red-600 dark:text-red-400 break-words">
        {t("chat.timeline.stopped", { reason: end.error })}
      </p>
    );
  }
  if (outcome === "interrupted") {
    const reason = end.reason || (end.error ? end.error : null);
    if (!reason) return null;
    return (
      <div role="status" aria-label={t("chat.timeline.interruptedByYou")} className="flex flex-col gap-0.5 px-1 text-chat-note text-gray-500 dark:text-white/45">
        <p className="m-0 font-medium text-gray-700 dark:text-white/70">
          {t("chat.timeline.interruptedByYou")}
        </p>
        <p className="m-0 break-words text-gray-500 dark:text-white/45">
          {reason}
        </p>
      </div>
    );
  }
  return null;
}
