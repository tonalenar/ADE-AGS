import { useTranslation } from "react-i18next";

import { CommentIcon, DotsIcon, PencilIcon } from "./studioIcons";

/**
 * A barra rápida sobre o elemento escolhido dentro da prancheta: editar o texto no lugar, comentar,
 * apagar o elemento e abrir o painel. Posição em px da superfície (acima do elemento, ou abaixo se
 * não couber).
 */
export function QuickBar({ at, canEditText, onEditText, onComment, onDelete, onMore }: {
  at: { left: number; top: number };
  canEditText: boolean;
  onEditText: () => void;
  onComment: () => void;
  onDelete: () => void;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const btn = "h-7 px-2 rounded-md inline-flex items-center gap-1 text-[12px] text-gray-700 dark:text-white/80 hover:bg-gray-100 dark:hover:bg-white/10";
  return (
    <div role="toolbar" aria-label={t("design.quick.label")} data-studio-popover=""
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-30 flex items-center gap-0.5 p-0.5 rounded-lg bg-white dark:bg-surface-raised
        shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_8px_24px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.08)]"
      style={at}>
      {canEditText && <button type="button" className={btn} onClick={onEditText}><PencilIcon className="w-3.5 h-3.5" />{t("design.quick.editText")}</button>}
      <button type="button" className={btn} onClick={onComment} title={t("design.quick.commentHint")}><CommentIcon className="w-3.5 h-3.5" />{t("design.quick.comment")}</button>
      <button type="button" className={`${btn} text-red-600 dark:text-red-400`} onClick={onDelete}>{t("design.quick.delete")}</button>
      <button type="button" className={btn} onClick={onMore} aria-label={t("design.quick.more")} title={t("design.quick.more")}><DotsIcon className="w-3.5 h-3.5" /></button>
    </div>
  );
}

/** Onde pôr a barra: 40 px acima do elemento; se sair por cima, 8 px abaixo. Presa na largura. Puro. */
export function quickBarPlacement(el: { x: number; y: number; w: number; h: number }, width: number, barW = 300): { left: number; top: number } {
  const top = el.y - 40 >= 4 ? el.y - 40 : el.y + el.h + 8;
  const left = Math.min(Math.max(4, el.x), Math.max(4, width - barW - 4));
  return { left, top };
}
