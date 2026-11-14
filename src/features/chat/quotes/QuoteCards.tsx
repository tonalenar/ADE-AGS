import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { ArrowUpRightIcon, PenIcon, QuoteIcon, XIcon } from "../chatIcons";
import { citationLabel, MAX_COMMENT_CHARS, resolveCommentDismissal } from "./quoteModel";

export interface QuoteCardItem {
  id: string;
  text: string;
  comment: string;
  originItemId?: string;
}

function popoverCoordinates(anchor: DOMRect | null, width: number, estimatedHeight = 200) {
  if (!anchor || (anchor.width === 0 && anchor.height === 0)) {
    return {
      left: Math.max(8, (window.innerWidth - width) / 2),
      top: Math.max(8, Math.min(140, window.innerHeight - estimatedHeight - 8)),
    };
  }
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  const preferAbove = anchor.top - estimatedHeight - 8 >= 8;
  const top = preferAbove
    ? Math.max(8, anchor.top - estimatedHeight - 8)
    : Math.min(anchor.bottom + 8, window.innerHeight - estimatedHeight - 8);
  return { left, top };
}

/**
 * Popover do editor de comentário opcional da citação no composer (espelha `AssistantCitationCommentEditor` do T3 Code).
 */
function CitationCommentPopover({
  item,
  anchorEl,
  onSave,
  onSaveAndSend,
  onClose,
}: {
  item: QuoteCardItem;
  anchorEl: HTMLElement | null;
  onSave: (comment: string) => boolean;
  onSaveAndSend?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(item.comment);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const anchorRect = anchorEl?.getBoundingClientRect() ?? null;
  const [pos, setPos] = useState(() => popoverCoordinates(anchorRect, 320, 210));

  useLayoutEffect(() => {
    const popup = popupRef.current;
    const input = inputRef.current;
    if (input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (!popup || !anchorEl) return;
    const rect = popup.getBoundingClientRect();
    const ar = anchorEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && (ar.width > 0 || ar.height > 0)) {
      setPos(popoverCoordinates(ar, rect.width, rect.height));
    }
  }, [anchorEl]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (popupRef.current?.contains(target) || anchorEl?.contains(target)) return;
      const decision = resolveCommentDismissal({
        reason: "outside-press",
        draft: draftRef.current,
        savedComment: item.comment,
      });
      if (decision.kind === "keep-open") return;
      if (decision.kind === "commit" && !onSave(decision.comment)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorEl, item.comment, onClose, onSave]);

  const tooLong = draft.length > MAX_COMMENT_CHARS;

  const submit = () => {
    if (tooLong) return;
    if (onSave(draft)) onClose();
  };

  const submitAndSend = () => {
    if (tooLong) return;
    if (!onSave(draft)) return;
    onClose();
    onSaveAndSend?.();
  };

  return createPortal(
    <div
      ref={popupRef}
      role="dialog"
      aria-label={t("chat.quote.editComment")}
      data-citation-comment-editor="true"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 10050 }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onClose();
        }
      }}
      className="cc-surface-glass cc-cite-in w-80 max-w-[calc(100vw-1rem)] rounded-xl p-3
        border border-gray-900/12 dark:border-white/15
        shadow-[0_12px_32px_-8px_rgba(0,0,0,0.28)] dark:shadow-[0_16px_40px_-8px_rgba(0,0,0,0.6)]
        flex flex-col gap-2"
    >
      <blockquote className="m-0 max-h-28 overflow-y-auto border-l-2 border-gray-300 dark:border-white/25 pl-3 text-chat-caption leading-snug text-gray-500 dark:text-white/55 whitespace-pre-wrap break-words">
        {item.text}
      </blockquote>
      <textarea
        ref={inputRef}
        data-citation-comment-input=""
        rows={2}
        value={draft}
        aria-label={t("chat.quote.editComment")}
        aria-invalid={tooLong || undefined}
        placeholder={t("chat.quote.optionalPlaceholder")}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) submitAndSend();
            else submit();
          }
        }}
        className="w-full resize-none rounded-lg bg-gray-100/80 dark:bg-white/[0.07] px-2.5 py-1.5 outline-none
          text-chat-note text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/35"
      />
      {tooLong && (
        <p role="status" className="m-0 text-chat-caption text-red-600 dark:text-red-400">
          {t("chat.quote.commentTooLong", { count: MAX_COMMENT_CHARS })}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 text-chat-caption">
        <span className="mr-auto text-gray-500 dark:text-white/45 truncate">{t("chat.quote.commentHint")}</span>
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
          className="h-7 px-2.5 rounded-md text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/10"
        >
          {t("btn.cancel")}
        </button>
        <button
          type="button"
          disabled={tooLong}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
          className="h-7 px-2.5 rounded-md bg-accent-600 text-white font-medium hover:bg-accent-700 disabled:opacity-45"
        >
          {tooLong ? t("chat.quote.shortenComment") : t("chat.quote.save")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Popover somente leitura da citação dentro da bolha enviada (espelha `ContextChipPopover` + `AssistantCitationQuote` do T3 Code).
 */
function CitationDetailPopover({
  item,
  anchorEl,
  onNavigate,
  onClose,
}: {
  item: QuoteCardItem;
  anchorEl: HTMLElement | null;
  onNavigate?: (originItemId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRect = anchorEl?.getBoundingClientRect() ?? null;
  const [pos, setPos] = useState(() => popoverCoordinates(anchorRect, 360, 180));

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!popup || !anchorEl) return;
    const rect = popup.getBoundingClientRect();
    const ar = anchorEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && (ar.width > 0 || ar.height > 0)) {
      setPos(popoverCoordinates(ar, rect.width, rect.height));
    }
  }, [anchorEl]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (popupRef.current?.contains(target) || anchorEl?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={popupRef}
      role="dialog"
      aria-label={t("chat.quote.assistantQuote")}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 10050 }}
      className="cc-surface-glass cc-cite-in w-96 max-w-[calc(100vw-1rem)] rounded-xl p-3
        border border-gray-900/12 dark:border-white/15
        shadow-[0_12px_32px_-8px_rgba(0,0,0,0.28)] dark:shadow-[0_16px_40px_-8px_rgba(0,0,0,0.6)]
        flex flex-col items-start gap-3 text-chat-note"
    >
      <div className="max-h-64 min-h-0 w-full space-y-3 overflow-y-auto whitespace-pre-wrap break-words">
        <blockquote className="m-0 border-l-2 border-gray-300 dark:border-white/25 pl-3 text-gray-600 dark:text-white/65">
          {item.text}
        </blockquote>
        {item.comment && <p className="m-0 text-gray-900 dark:text-white">{item.comment}</p>}
      </div>
      {item.originItemId && onNavigate && (
        <button
          type="button"
          onClick={() => {
            onClose();
            onNavigate(item.originItemId!);
          }}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-white/15 px-2.5 py-1
            text-chat-caption font-medium text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/10"
        >
          <ArrowUpRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t("chat.quote.goToSource")}</span>
        </button>
      )}
    </div>,
    document.body,
  );
}

/**
 * Chips de citação alinhados ao `AssistantCitationChip` do T3 Code:
 * - No composer (`onRemove` / `onUpdateComment`): chips azuis compactos acima do campo com ícone de aspas,
 *   prévia clicável para ir à origem, lápis para comentário opcional e «×» para remover.
 * - Na bolha enviada (somente leitura): chips compactos clicáveis que abrem o popover com a citação completa.
 */
export function QuoteCards({
  items,
  onRemove,
  onUpdateComment,
  onSaveAndSend,
  onNavigate,
  className = "",
}: {
  items: QuoteCardItem[];
  onRemove?: (id: string) => void;
  onUpdateComment?: (id: string, comment: string) => boolean;
  onSaveAndSend?: () => void;
  onNavigate?: (originItemId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const chipRefs = useRef<Record<string, HTMLElement | null>>({});

  if (items.length === 0) return null;

  const composerMode = Boolean(onRemove || onUpdateComment);

  if (!composerMode) {
    const activeDetail = detailId ? items.find((q) => q.id === detailId) ?? null : null;
    return (
      <>
        <ul aria-label={t("chat.quote.list")} className={`list-none m-0 p-0 flex flex-wrap items-center gap-1.5 ${className}`}>
          {items.map((q) => {
            const label = citationLabel(q);
            const open = detailId === q.id;
            return (
              <li key={q.id} className="inline-flex max-w-full">
                <button
                  ref={(el) => { chipRefs.current[q.id] = el; }}
                  type="button"
                  data-citation-bubble-chip=""
                  aria-expanded={open}
                  aria-label={t("chat.quote.showDetails", { label })}
                  title={`${t("chat.quote.assistantQuote")}: ${q.text}`}
                  onClick={() => setDetailId((cur) => (cur === q.id ? null : q.id))}
                  className="inline-flex max-w-full items-center gap-[0.25em] rounded-sm font-medium text-chat-note
                    text-(--cc-citation-bubble-ink) hover:underline underline-offset-[0.2em] cursor-pointer
                    focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
                >
                  <QuoteIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 max-w-[16em] truncate">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {activeDetail && (
          <CitationDetailPopover
            item={activeDetail}
            anchorEl={chipRefs.current[activeDetail.id] ?? null}
            onNavigate={onNavigate}
            onClose={() => setDetailId(null)}
          />
        )}
      </>
    );
  }

  const activeEditing = editingId ? items.find((q) => q.id === editingId) ?? null : null;

  return (
    <>
      <ul aria-label={t("chat.quote.list")} className={`list-none m-0 p-0 flex flex-wrap items-center gap-1.5 ${className}`}>
        {items.map((q) => {
          const label = citationLabel(q);
          const canNavigate = Boolean(q.originItemId && onNavigate);
          const sourceContent = (
            <>
              <QuoteIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 max-w-[16em] truncate">{label}</span>
            </>
          );
          return (
            <li
              key={q.id}
              ref={(el) => { chipRefs.current[q.id] = el; }}
              data-assistant-citation-chip="true"
              title={q.comment ? `${t("chat.quote.assistantQuote")}: ${q.text}
${q.comment}` : `${t("chat.quote.assistantQuote")}: ${q.text}`}
              className="group relative inline-flex max-w-full items-center gap-1 rounded-lg
                bg-accent-500/[0.08] dark:bg-accent-400/[0.12]
                border border-accent-500/20 dark:border-accent-400/20
                px-2 py-1 text-chat-caption font-medium text-(--cc-citation-accent) dark:text-accent-300"
            >
              {canNavigate ? (
                <button
                  type="button"
                  onClick={() => onNavigate?.(q.originItemId!)}
                  aria-label={t("chat.quote.viewSource", { label })}
                  className="inline-flex min-w-0 items-center gap-[0.25em] text-inherit hover:underline underline-offset-[0.2em] cursor-pointer focus-visible:outline-2 focus-visible:outline-current rounded-sm"
                >
                  {sourceContent}
                </button>
              ) : (
                <span
                  aria-label={t("chat.quote.viewSource", { label })}
                  className="inline-flex min-w-0 items-center gap-[0.25em]"
                >
                  {sourceContent}
                </span>
              )}
              {onUpdateComment && (
                <button
                  type="button"
                  data-citation-comment-trigger=""
                  onClick={() => setEditingId((cur) => (cur === q.id ? null : q.id))}
                  aria-label={q.comment ? t("chat.quote.editComment") : t("chat.quote.addComment")}
                  title={q.comment ? t("chat.quote.editComment") : t("chat.quote.addComment")}
                  className="ml-0.5 inline-flex w-4 h-4 shrink-0 items-center justify-center rounded-sm
                    hover:bg-accent-500/15 dark:hover:bg-accent-400/20 cursor-pointer
                    focus-visible:outline-2 focus-visible:outline-current"
                >
                  <PenIcon className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  data-citation-remove=""
                  onClick={() => {
                    if (editingId === q.id) setEditingId(null);
                    onRemove(q.id);
                  }}
                  aria-label={t("chat.quote.remove")}
                  title={t("chat.quote.remove")}
                  className="inline-flex w-4 h-4 shrink-0 items-center justify-center rounded-sm
                    hover:bg-accent-500/15 dark:hover:bg-accent-400/20 cursor-pointer
                    focus-visible:outline-2 focus-visible:outline-current"
                >
                  <XIcon className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {activeEditing && onUpdateComment && (
        <CitationCommentPopover
          key={activeEditing.id}
          item={activeEditing}
          anchorEl={chipRefs.current[activeEditing.id] ?? null}
          onSave={(comment) => onUpdateComment(activeEditing.id, comment)}
          onSaveAndSend={onSaveAndSend}
          onClose={() => setEditingId(null)}
        />
      )}
    </>
  );
}
