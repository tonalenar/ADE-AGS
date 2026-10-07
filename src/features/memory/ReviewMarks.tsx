import { useTranslation } from "react-i18next";

import { reviewMarks } from "./review";
import type { MemoryReviewItem } from "./types";

const STYLE = {
  duplicate: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  contradiction: "border-red-500/60 text-red-600 dark:text-red-400",
} as const;

/**
 * Marcas de suspeita da checagem automática. Sempre "possível": quem decide é o usuário, nada é
 * aprovado ou rejeitado sozinho. Mostra as duas quando a entrada é duplicata e contradição.
 */
export function ReviewMarks({ item }: { item: MemoryReviewItem }) {
  const { t } = useTranslation();
  const marks = reviewMarks(item);
  if (marks.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-wrap gap-1.5" aria-label={t("memoryReview.marksLabel")}>
        {marks.map((m) => (
          <li key={m.kind} data-mark={m.kind} className={`rounded-full border px-2 py-px text-[10.5px] ${STYLE[m.kind]}`}>
            {t(m.kind === "duplicate" ? "memoryReview.markDuplicate" : "memoryReview.markContradiction", { key: m.key })}
          </li>
        ))}
      </ul>
      <p className="text-[10.5px] text-gray-400 dark:text-white/35">{t("memoryReview.markNote")}</p>
    </div>
  );
}
