import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";

import { QuoteIcon } from "../chatIcons";
import { MAX_QUOTE_CHARS } from "./quoteModel";
import { addQuoteAndOpenCommentFor } from "./quoteStore";
import {
  matchCommentShortcut,
  observeSelectionActions,
  resolveSelectionActionPosition,
  selectionTarget,
  type SelectionActionPoint,
  type SelectionTarget,
} from "./selectionModel";

type FloatingCite = {
  target: SelectionTarget;
  position: SelectionActionPoint;
};

/**
 * Botão flutuante «Citar» estilo T3 Code (`AssistantSelectionToolbar.tsx`):
 * aparece como uma pílula translúcida logo abaixo do fim da seleção dentro de áreas citáveis
 * (`[data-quotable]`), fecha ao clicar fora, rolar, limpar seleção ou apertar Esc, e aceita `Tab`
 * para foco por teclado. Clicar insere imediatamente o chip no composer (comentário opcional).
 */
export function SelectionComment({
  container,
  quoteKey,
}: {
  container: () => Element | null;
  quoteKey: string;
}) {
  const { t } = useTranslation();
  const [floating, setFloating] = useState<FloatingCite | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const floatingRef = useRef<FloatingCite | null>(null);
  floatingRef.current = floating;

  useEffect(() => {
    const element = container();
    if (!element) {
      setFloating(null);
      return;
    }

    const clear = () => setFloating(null);

    const update = (pointer: SelectionActionPoint | null) => {
      const target = selectionTarget(window.getSelection(), element);
      if (!target) {
        clear();
        return;
      }
      const bounds = element.getBoundingClientRect();
      const effectiveBounds =
        bounds.width > 0 && bounds.height > 0
          ? bounds
          : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const position = resolveSelectionActionPosition({
        bounds: effectiveBounds,
        selectionRect: { right: target.rect.right, bottom: target.rect.bottom },
        pointer:
          pointer &&
          pointer.x >= target.rect.left - 8 &&
          pointer.x <= target.rect.right + 8 &&
          pointer.y >= target.rect.top - 8 &&
          pointer.y <= target.rect.bottom + 8
            ? pointer
            : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setFloating({ target, position });
    };

    const actions = observeSelectionActions({
      element,
      getActionElement: () => toolbarRef.current,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;

    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      if (toolbar.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };

    const onShortcut = (event: KeyboardEvent) => {
      if (!matchCommentShortcut(event, DESKTOP_OS === "macos")) return;
      const target = floatingRef.current?.target ?? selectionTarget(window.getSelection(), element);
      if (!target || target.text.length > MAX_QUOTE_CHARS) return;
      event.preventDefault();
      const quoted = target.source
        ? `${t("chat.quote.source", { source: target.source })}
${target.text}`
        : target.text;
      const sourceAnchor =
        target.sourceElement && target.range
          ? { source: target.sourceElement, range: target.range, rect: target.rect }
          : undefined;
      if (
        addQuoteAndOpenCommentFor(
          quoteKey,
          { text: quoted, comment: "", originItemId: target.originItemId },
          { sourceAnchor, removeOnCancel: true },
        )
      ) {
        window.getSelection()?.removeAllRanges();
        actionsRef.current?.cancel();
        clear();
      }
    };

    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("keydown", onShortcut, true);
    document.addEventListener("selectionchange", actions.selectionChanged);

    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("keydown", onShortcut, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [container, quoteKey, t]);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!floating || !toolbar) return;
    const rect = toolbar.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const left = Math.max(8, Math.min(floating.position.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(floating.position.y, window.innerHeight - rect.height - 8));
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }, [floating]);

  if (!floating) return null;

  const tooLong = floating.target.text.length > MAX_QUOTE_CHARS;

  const dismiss = () => {
    actionsRef.current?.cancel();
    setFloating(null);
  };

  const cite = () => {
    if (tooLong) return;
    const quoted = floating.target.source
      ? `${t("chat.quote.source", { source: floating.target.source })}
${floating.target.text}`
      : floating.target.text;
    const sourceAnchor =
      floating.target.sourceElement && floating.target.range
        ? { source: floating.target.sourceElement, range: floating.target.range, rect: floating.target.rect }
        : undefined;
    const added = addQuoteAndOpenCommentFor(
      quoteKey,
      {
        text: quoted,
        comment: "",
        originItemId: floating.target.originItemId,
      },
      { sourceAnchor, removeOnCancel: true },
    );
    if (!added) return;
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  return createPortal(
    <button
      ref={toolbarRef}
      type="button"
      data-cite-toolbar=""
      disabled={tooLong}
      aria-label={tooLong ? t("chat.quote.tooLongAria") : t("chat.quote.citeAria")}
      title={`${t("chat.quote.cite")} (${DESKTOP_OS === "macos" ? "⌥⌘M" : "Ctrl+Shift+M"})`}
      style={{ position: "fixed", left: floating.position.x, top: floating.position.y, zIndex: 10040 }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
      className="cc-surface-glass cc-cite-in inline-flex h-6 max-w-[calc(100vw-1rem)] items-center gap-1 rounded-full px-2
        border border-gray-900/12 dark:border-white/15 hover:border-gray-900/22 dark:hover:border-white/25
        text-chat-caption font-medium whitespace-nowrap text-gray-900 dark:text-white
        shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-1px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)]
        active:scale-[0.97] transition-[box-shadow,transform,border-color] cursor-pointer
        disabled:cursor-not-allowed disabled:opacity-50
        focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500"
    >
      <QuoteIcon aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-white/60" />
      <span>{tooLong ? t("chat.quote.shortenSelection") : t("chat.quote.cite")}</span>
    </button>,
    document.body,
  );
}
