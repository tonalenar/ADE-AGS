import { useTranslation } from "react-i18next";

import { XIcon } from "../chatIcons";

/**
 * Os cartões de citação: o trecho citado em cinza (cortado) e o comentário. No composer levam o «×» (mouse ou foco);
 * na bolha enviada são só leitura.
 */
export function QuoteCards({ items, onRemove, className = "" }: {
  items: { id: string; text: string; comment: string }[];
  onRemove?: (id: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <ul aria-label={t("chat.quote.list")} className={`list-none m-0 p-0 flex flex-col gap-1.5 ${className}`}>
      {items.map((q) => (
        <li key={q.id} className="group relative rounded-xl bg-gray-100 dark:bg-white/[0.07] border-l-[3px] border-gray-300 dark:border-white/25 pl-3 pr-8 py-1.5 text-left">
          <p className="m-0 text-chat-caption leading-snug text-gray-500 dark:text-white/50 line-clamp-2 whitespace-pre-wrap break-words" title={q.text}>{q.text}</p>
          <p className="m-0 mt-0.5 text-chat-note text-gray-900 dark:text-white whitespace-pre-wrap break-words">{q.comment}</p>
          {onRemove && (
            <button type="button" onClick={() => onRemove(q.id)} aria-label={t("chat.quote.remove")} title={t("chat.quote.remove")}
              className="absolute top-1 right-1 w-6 h-6 rounded-md flex items-center justify-center text-gray-500 dark:text-white/50 hover:bg-gray-200 dark:hover:bg-white/10
                opacity-0 group-hover:opacity-100 focus:opacity-100 group-focus-within:opacity-100">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
