import { useTranslation } from "react-i18next";

import { noticeDetail } from "./timelineModel";
import type { TimelineItem } from "./types";

/**
 * Um aviso do app no fio: a sessão que não voltou (o agente recomeçou sem o histórico), a mensagem que saiu da
 * fila sem ser enviada (com «Reenviar») ou uma opção que o agente não aplicou. A frase vem do código; o motivo, do item.
 */
export function NoticeRow({ item, onResend }: { item: TimelineItem; onResend?: (text: string) => void }) {
  const { t } = useTranslation();
  const code = item.label ?? "";
  const known = code === "resumeLost" || code === "queueDropped" || code === "optionIgnored";
  const detail = noticeDetail(item);
  return (
    <div role="status" className="flex flex-col gap-1 px-1 text-chat-note text-amber-700 dark:text-amber-400">
      <p className="m-0 font-medium">{known ? t(`chat.timeline.notice.${code}`) : detail}</p>
      {known && detail && (
        <p className={`m-0 break-words text-gray-600 dark:text-white/60 ${code === "queueDropped" ? "italic" : ""}`}>{detail}</p>
      )}
      {code === "queueDropped" && onResend && detail && (
        <button type="button" onClick={() => onResend(detail)}
          className="self-start h-6 px-2 rounded-md border border-gray-200 dark:border-white/10 text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
          {t("chat.timeline.notice.resend")}
        </button>
      )}
    </div>
  );
}
