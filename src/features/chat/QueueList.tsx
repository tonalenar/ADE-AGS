import { useTranslation } from "react-i18next";

import { ClockIcon, PenIcon, XIcon, ZapIcon } from "./chatIcons";
import type { QueuedMessage } from "./store";

/**
 * As mensagens esperando a vez, logo acima da caixa do composer: «Na fila» (sai quando o turno acabar) ou «Vai assim
 * que o turno parar» (o «enviar agora» num motor que não aceita entrada no meio do turno). Cada uma mostra o texto
 * numa linha, e dá para editar (volta para a caixa e sai da fila) ou tirar.
 */
export function QueueList({ items, onEdit, onRemove }: {
  items: QueuedMessage[];
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <ul aria-label={t("chat.queue.label")} className="list-none m-0 mb-2 p-0 flex flex-col gap-1">
      {items.map((m) => {
        const Icon = m.now ? ZapIcon : ClockIcon;
        return (
          <li key={m.id} data-queued={m.now ? "now" : "queued"}
            className="flex items-center gap-2 min-w-0 h-8 pl-2.5 pr-1 rounded-[10px] border border-black/[0.08] dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.04] text-chat-caption">
            <Icon className={`w-3.5 h-3.5 shrink-0 ${m.now ? "text-orange-700 dark:text-orange-400" : "text-gray-500 dark:text-white/45"}`} />
            <span className="shrink-0 font-medium text-gray-600 dark:text-white/60">{m.now ? t("chat.queue.afterStop") : t("chat.queue.queued")}</span>
            <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-white/85" title={m.text}>{m.text}</span>
            <button type="button" onClick={() => onEdit(m.id)} aria-label={t("chat.queue.edit")} title={t("chat.queue.edit")}
              className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-200/70 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
              <PenIcon className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => onRemove(m.id)} aria-label={t("chat.queue.remove")} title={t("chat.queue.remove")}
              className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-200/70 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
