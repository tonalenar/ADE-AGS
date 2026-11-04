import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";

import { addQuoteFor } from "./quoteStore";
import { matchCommentShortcut, selectionTarget, type SelectionTarget } from "./selectionModel";

/** Quanto do trecho a caixinha mostra (o resto fica de fora; o texto inteiro vai na citação). */
const PREVIEW_CHARS = 280;

/**
 * «Comentar», como no Claude: ao selecionar um trecho de uma fala da conversa aparece um botão junto da seleção; ele
 * abre uma caixinha que cita o trecho (em cinza) com um campo para o comentário. Enter adiciona a citação ao composer
 * da conversa (um cartão acima do campo, removível), Esc fecha. Pelo teclado: o atalho (⌥⌘M / Ctrl+Shift+M) abre a
 * caixinha para a seleção que já existe. `container` é a lista da conversa; só seleções dentro das falas valem.
 */
export function SelectionComment({ container, quoteKey }: { container: () => Element | null; quoteKey: string }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<SelectionTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  // Com a caixinha aberta a seleção some (o foco vai ao campo): o trecho guardado é o que vale.
  const openRef = useRef(false);
  openRef.current = open;
  const targetRef = useRef<SelectionTarget | null>(null);
  targetRef.current = target;

  useEffect(() => {
    const refresh = () => {
      if (openRef.current) return;
      setTarget(selectionTarget(window.getSelection(), container()));
    };
    const onKey = (e: KeyboardEvent) => {
      if (!targetRef.current || openRef.current || !matchCommentShortcut(e, DESKTOP_OS === "macos")) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("selectionchange", refresh);
    document.addEventListener("mouseup", refresh);
    document.addEventListener("keyup", refresh);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      document.removeEventListener("mouseup", refresh);
      document.removeEventListener("keyup", refresh);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [container]);

  if (!target) return null;
  const close = () => { setOpen(false); setComment(""); setTarget(null); };
  const submit = () => {
    const text = comment.trim();
    if (!text) return;
    addQuoteFor(quoteKey, { text: target.text, comment: text });
    window.getSelection()?.removeAllRanges();
    close();
    // O foco volta ao campo de mensagem, onde o cartão acabou de aparecer.
    document.querySelector<HTMLElement>("[data-chat-composer]")?.focus();
  };
  const left = Math.max(8, Math.min(target.rect.right, window.innerWidth - 130));
  const top = Math.min(target.rect.bottom + 6, window.innerHeight - 48);

  if (!open) {
    return createPortal(
      <button type="button" aria-label={t("chat.quote.comment")} title={`${t("chat.quote.comment")} (${DESKTOP_OS === "macos" ? "⌥⌘M" : "Ctrl+Shift+M"})`}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)}
        style={{ position: "fixed", left, top, zIndex: 10040 }}
        className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-chat-ui font-medium bg-white dark:bg-surface-raised text-gray-900 dark:text-white
          shadow-[0_0_0_1px_rgba(24,24,27,0.12),0_8px_24px_-8px_rgba(0,0,0,0.4)] hover:bg-gray-50 dark:hover:bg-white/10">
        {t("chat.quote.comment")}
      </button>,
      document.body,
    );
  }
  const preview = target.text.length > PREVIEW_CHARS ? `${target.text.slice(0, PREVIEW_CHARS).trimEnd()}…` : target.text;
  return createPortal(
    <div role="dialog" aria-label={t("chat.quote.title")} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}
      style={{ position: "fixed", left: Math.max(8, Math.min(target.rect.left, window.innerWidth - 348)), top: Math.min(target.rect.bottom + 8, window.innerHeight - 220), width: 340, zIndex: 10040 }}
      className="rounded-xl p-3 flex flex-col gap-2 bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(24,24,27,0.12),0_16px_40px_-12px_rgba(0,0,0,0.5)]">
      <p className="m-0 border-l-[3px] border-gray-300 dark:border-white/25 pl-2.5 text-chat-caption leading-snug text-gray-500 dark:text-white/50 line-clamp-4 whitespace-pre-wrap break-words">{preview}</p>
      <textarea autoFocus rows={2} value={comment} aria-label={t("chat.quote.field")} placeholder={t("chat.quote.placeholder")}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
        }}
        className="w-full resize-none rounded-lg bg-gray-100 dark:bg-white/[0.07] px-2.5 py-2 outline-none text-chat-note text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/35" />
      <div className="flex items-center gap-2 text-chat-caption text-gray-500 dark:text-white/45">
        <span className="flex-1">{t("chat.quote.hint")}</span>
        <button type="button" onClick={close} className="h-7 px-2 rounded-md hover:bg-gray-100 dark:hover:bg-white/10">{t("btn.cancel")}</button>
        <button type="button" onClick={submit} disabled={!comment.trim()} className="h-7 px-2.5 rounded-md bg-accent-600 text-white font-medium disabled:opacity-40">{t("chat.quote.add")}</button>
      </div>
    </div>,
    document.body,
  );
}
