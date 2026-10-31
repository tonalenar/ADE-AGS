import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { ArrowUpIcon, PaperclipIcon, StopIcon } from "./chatIcons";
import { useChatStore } from "./store";

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

/** Junta um trecho ao texto, com um espaço entre os dois e outro no fim. Pura. */
export function appendMention(prev: string, mention: string): string {
  return prev && !/\s$/.test(prev) ? `${prev} ${mention} ` : `${prev}${mention} `;
}

/** O que o `addon` do composer recebe: o texto, o cursor e como trocar os dois. */
export interface ComposerAddonContext {
  text: string;
  caret: number;
  apply: (text: string, caret: number) => void;
}

/**
 * A caixa do composer da prancheta (a do T3 Code): cartão de vidro com cantos de 16 px, o texto em
 * cima e, embaixo, anexar à esquerda, os controles e o botão redondo de 32 px à direita. Enter
 * envia na hora; Shift+Enter quebra a linha; ⌘⏎ (Ctrl+Enter fora do macOS) põe na fila quando há
 * `onQueue` (prancheta 13), e a fila aparece embaixo ("Fila: 1 mensagem"). Com o agente
 * trabalhando e a caixa vazia, o botão vira Parar.
 */
export function ChatComposer({ placeholder, controls, leading = null, addon, onSubmit, onStop, onQueue, queued = 0, cwd = null, disabled = false, autoFocus = false }: {
  placeholder: string;
  /** Logo depois do anexar, à esquerda (o segmentado "Time | Só o orquestrador", prancheta 15). */
  leading?: React.ReactNode;
  /** Acima da caixa, com o texto e o cursor (o menu do @agente do time). `apply` troca os dois. */
  addon?: (ctx: ComposerAddonContext) => React.ReactNode;
  /** Entre o espaço vazio e o botão de enviar. */
  controls?: React.ReactNode;
  /** `false` (ou erro) = não foi: o texto continua na caixa. */
  onSubmit: (text: string) => boolean | void | Promise<boolean | void>;
  /** O agente está trabalhando: o botão vira Parar (com a caixa vazia). */
  onStop?: (() => void) | null;
  /** ⌘⏎: põe a mensagem na fila da conversa (sai quando o turno acabar). */
  onQueue?: ((text: string) => void) | null;
  /** Quantas mensagens esperam na fila. */
  queued?: number;
  /** A pasta da conversa, para o anexo virar um caminho relativo. */
  cwd?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [caret, setCaret] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  // O cursor pedido por `apply` (o @ trocado pelo apelido): aplicado depois de o texto mudar.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);
  const apply = (next: string, at: number) => { pendingCaret.current = at; setText(next); };
  const canSend = text.trim().length > 0 && !disabled && !busy;
  const stopping = !!onStop && text.trim().length === 0;

  // O que o painel manda para a conversa (a captura de um aparelho) entra no fim do texto.
  const insert = useChatStore((s) => s.composerInsert);
  const seen = useRef(insert?.seq ?? 0);
  useEffect(() => {
    if (!insert || insert.seq === seen.current) return;
    seen.current = insert.seq;
    setText((prev) => appendMention(prev, insert.text));
    ref.current?.focus();
  }, [insert]);

  // Cresce com o texto até `MAX_ROWS` linhas.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`;
  }, [text]);

  const queue = () => {
    if (!onQueue || text.trim().length === 0 || disabled) return;
    onQueue(text);
    setText("");
  };

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
    setText((prev) => appendMention(prev, mentions));
    ref.current?.focus();
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      className="w-full rounded-[20px] border border-black/[0.10] dark:border-white/[0.10]
        bg-white dark:bg-surface-raised
        shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:shadow-none"
    >
      {addon?.({ text, caret, apply })}
      <label className="block px-5 pt-4 pb-2">
        <span className="sr-only">{t("chat.composer.label")}</span>
        <textarea ref={ref} rows={1} value={text} autoFocus={autoFocus}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if ((e.metaKey || e.ctrlKey) && onQueue) queue();
              else void submit();
            }
          }}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent outline-none text-chat-prose
            text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/35" />
      </label>
      {/*
        A linha de baixo QUEBRA quando falta espaço (a coluna fica estreita com o painel direito aberto): o
        grupo da esquerda (anexar, "Time | Só o orquestrador", fila) e o da direita (controles e enviar)
        viram duas linhas, nunca estouram o cartão. O enviar é sempre o último do grupo da direita, no canto.
      */}
      <div data-composer-row className="flex flex-wrap items-center justify-between gap-x-1 gap-y-1 px-3 pb-2.5">
        <div data-composer-left className="flex min-w-0 max-w-full items-center gap-0.5">
        <button type="button" onClick={() => { void attach(); }} aria-label={t("chat.composer.attach")} title={t("chat.composer.attach")}
          className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
          <PaperclipIcon className="w-4 h-4" />
        </button>
        {leading}
        {queued > 0 && (
          <span role="status" className="pl-2 text-chat-caption whitespace-nowrap text-gray-500 dark:text-white/45">{t("chat.composer.queued", { count: queued })}</span>
        )}
        </div>
        <div data-composer-right className="ml-auto flex min-w-0 max-w-full items-center gap-0.5">
        <div data-composer-controls className="flex min-w-0 flex-wrap items-center justify-end gap-x-0.5 gap-y-1">{controls}</div>
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
      </div>
    </form>
  );
}
