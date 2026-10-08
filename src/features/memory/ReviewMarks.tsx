import { useTranslation } from "react-i18next";

import { reviewMarks } from "./review";
import type { MemoryReviewItem } from "./types";

/** Selos "possível …": pílula de 18px, fundo da cor a 15% e texto na cor. */
const STYLE = {
  duplicate: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  contradiction: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
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
          <li key={m.kind} data-mark={m.kind}
            className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10.5px] font-semibold whitespace-nowrap ${STYLE[m.kind]}`}>
            {t(m.kind === "duplicate" ? "memoryReview.markDuplicate" : "memoryReview.markContradiction", { key: m.key })}
          </li>
        ))}
      </ul>
      <p className="text-[10.5px] leading-[14px] text-gray-500 dark:text-white/40">{t("memoryReview.markNote")}</p>
    </div>
  );
}
