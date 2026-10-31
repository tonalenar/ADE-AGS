import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { ArrowUpIcon, PaperclipIcon, StopIcon } from "./chatIcons";

/** Até quantas linhas a caixa cresce antes de rolar. */
const MAX_ROWS = 10;

/** O caminho do arquivo relativo à pasta da conversa (com `/`), ou o absoluto se for de fora. Pura. */
export function mentionFor(cwd: string | null, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const base = cwd ? norm(cwd).replace(/\/+$/, "") + "/" : null;
  const file = norm(path);
  const rel = base && file.startsWith(base) ? file.slice(base.length) : file;
  return `@${/\s/.test(rel) ? `"${rel}"` : rel}`;
}

/**
 * A caixa do composer da prancheta (a do T3 Code): cartão de vidro com cantos de 16 px, o texto em
 * cima e, embaixo, anexar à esquerda, os controles e o botão redondo de 32 px à direita. Enter
 * envia; Shift+Enter quebra a linha. Com o agente trabalhando e a caixa vazia, o botão vira Parar.
 */
export function ChatComposer({ placeholder, controls, onSubmit, onStop, cwd = null, disabled = false, autoFocus = false }: {
  placeholder: string;
  /** Entre o espaço vazio e o botão de enviar. */
  controls?: React.ReactNode;
  /** `false` (ou erro) = não foi: o texto continua na caixa. */
  onSubmit: (text: string) => boolean | void | Promise<boolean | void>;
  /** O agente está trabalhando: o botão vira Parar (com a caixa vazia). */
  onStop?: (() => void) | null;
  /** A pasta da conversa, para o anexo virar um caminho relativo. */
  cwd?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0 && !disabled && !busy;
  const stopping = !!onStop && text.trim().length === 0;

  // Cresce com o texto até `MAX_ROWS` linhas.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`;
  }, [text]);

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      if ((await onSubmit(text)) !== false) setText("");
    } catch {
      /* quem envia mostra o erro; o texto fica para tentar de novo */
    } finally {
      setBusy(false);
    }
  };

  const attach = async () => {
    const picked = await openDialog({ multiple: true, directory: false, defaultPath: cwd ?? undefined, title: t("chat.composer.attach") });
    const files = typeof picked === "string" ? [picked] : picked ?? [];
    if (files.length === 0) return;
    const mentions = files.map((f) => mentionFor(cwd, f)).join(" ");
    setText((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${mentions} ` : `${prev}${mentions} `));
    ref.current?.focus();
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      className="w-full rounded-2xl border border-black/[0.08] dark:border-white/[0.05]
        bg-white/80 dark:bg-surface-raised/80 backdrop-blur-md backdrop-saturate-[1.14]
        shadow-[0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-none"
    >
      <label className="block px-4 pt-4 pb-2">
        <span className="sr-only">{t("chat.composer.label")}</span>
        <textarea ref={ref} rows={1} value={text} autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent outline-none text-[15px] leading-[1.5]
            text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/35" />
      </label>
      <div className="flex items-center gap-0.5 px-2 pb-2">
        <button type="button" onClick={() => { void attach(); }} aria-label={t("chat.composer.attach")} title={t("chat.composer.attach")}
          className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
          <PaperclipIcon className="w-4 h-4" />
        </button>
        <span className="flex-1" />
        {controls}
        {stopping ? (
          <button type="button" onClick={() => onStop?.()} aria-label={t("chat.composer.stop")} title={t("chat.composer.stop")}
            className="ml-1 w-8 h-8 shrink-0 rounded-full flex items-center justify-center bg-red-600/90 text-white hover:bg-red-600">
            <StopIcon className="w-2.5 h-2.5" />
          </button>
        ) : (
          <button type="submit" disabled={!canSend} aria-label={t("chat.composer.send")} title={t("chat.composer.send")}
            className={`ml-1 w-8 h-8 shrink-0 rounded-full flex items-center justify-center transition-transform
              ${canSend ? "bg-accent-600 text-white hover:scale-105" : "bg-gray-900/12 dark:bg-white/12 text-white dark:text-surface-deep cursor-default"}`}>
            <ArrowUpIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </form>
  );
}
