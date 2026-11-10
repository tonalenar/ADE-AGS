import { useTranslation } from "react-i18next";

import { endOutcome, type TurnEnd } from "./timelineModel";

/**
 * O aviso de um turno que não acabou bem: o motivo que o `turnEnd` gravou (erro do agente, processo que
 * caiu). Fica no fio da conversa, não só na linha viva, que some no próximo turno. "Interrompido por
 * você" e "concluído" não levam aviso: o rótulo do cabeçalho do turno já diz.
 */
export function TurnEndNotice({ end }: { end: TurnEnd }) {
  const { t } = useTranslation();
  if (endOutcome(end) !== "error") return null;
  return (
    <p role="alert" className="m-0 px-1 text-chat-note text-red-600 dark:text-red-400 break-words">
      {t("chat.timeline.stopped", { reason: end.error })}
    </p>
  );
}
