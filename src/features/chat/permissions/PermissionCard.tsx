import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { homeDir } from "@tauri-apps/api/path";

import { DESKTOP_OS } from "@/app/platform";

import { formatElapsed } from "../activityModel";
import { PadlockIcon } from "../chatIcons";
import { useNow } from "../liveSummary";
import { shortFolder, suggestPattern, type PendingAsk } from "./permissionModel";
import { TeamRoleTag } from "../team/TeamRoleTag";
import { alwaysAllow, answerAsk } from "./permissionsStore";

/** O título do pedido por tipo: "Codex quer rodar um comando". */
export const ASK_TITLE: Record<PendingAsk["kind"], string> = {
  command: "chat.permission.titleCommand",
  edit: "chat.permission.titleEdit",
  network: "chat.permission.titleNetwork",
};

let home: string | null = null;
let homeLoad: Promise<void> | null = null;

/** A pasta de casa (para escrever `~/Projects/…`), lida uma vez. */
export function useHome(): string | null {
  const [value, setValue] = useState(home);
  useEffect(() => {
    if (home !== null) return;
    homeLoad ??= homeDir().then((h) => { home = h; }).catch(() => undefined);
    void homeLoad.then(() => setValue(home));
  }, []);
  return value;
}

/** Uma tecla dentro de um botão, como a prancheta mostra (`N`, `⏎`). */
export function Kbd({ children, onPrimary = false, className = "" }: { children: React.ReactNode; onPrimary?: boolean; className?: string }) {
  return (
    <kbd className={`ml-1.5 px-1 rounded border font-sans text-[11px] font-normal
      ${onPrimary ? "text-accent-100 border-white/35" : "text-gray-500 dark:text-white/45 border-gray-200 dark:border-white/10"} ${className}`}>
      {children}
    </kbd>
  );
}

/** O foco está num lugar onde a tecla é texto (campo, terminal) ou ativa outro botão? */
function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

const isInteractive = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && typeof el.tagName === "string" && /^(BUTTON|A|SUMMARY)$/.test(el.tagName);
};

/** A linha "em ~/Projects/ADE-AGS · rede · mexe em package.json, bun.lock". */
export function AskMeta({ ask }: { ask: PendingAsk }) {
  const { t } = useTranslation();
  const homePath = useHome();
  const touches = ask.kind === "command" ? ask.files : [];
  const parts: React.ReactNode[] = [];
  if (ask.cwd) parts.push(<span key="in">{t("chat.permission.in")} <span className="font-mono">{shortFolder(ask.cwd, homePath)}</span></span>);
  if (ask.network) parts.push(<span key="net">{t("chat.permission.network")}</span>);
  if (touches.length > 0) {
    parts.push(
      <span key="touch">{t("chat.permission.touches")}{" "}
        {touches.map((f, i) => <span key={f}>{i > 0 && ", "}<span className="font-mono">{f}</span></span>)}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return <div className="text-chat-note text-gray-500 dark:text-white/45 break-words">{parts.map((p, i) => <span key={i}>{i > 0 && " · "}{p}</span>)}</div>;
}

/** Passa disto (caracteres ou linhas) e o comando ganha «Expandir»: antes, cabe em ~4 linhas com rolagem. */
const LONG_CHARS = 160;
const LONG_LINES = 3;

const BTN = "h-7 px-2.5 inline-flex items-center rounded-lg border border-gray-200 dark:border-white/10 text-chat-note text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70";

/**
 * O pedido de permissão do chat, colado ao composer (o desenho do T3 Code: o pedido fica acima da caixa,
 * sempre à vista, nunca na lista que rola por baixo dela). Uma linha com o cadeado, o título, o papel no
 * time e o tempo de espera; o comando (ou os arquivos) numa caixa mono com altura limitada, que rola por
 * dentro e expande sob pedido; onde e o que mexe; e as ações compactas: Negar (N), Responder…,
 * "Sempre permitir <padrão>" e Permitir (⏎). Ao chegar, o foco vai para Permitir, a menos que a pessoa
 * esteja digitando (o composer, o terminal). Responder nega e manda o texto ao agente. Risco alto não
 * oferece regra: nunca é permitido sozinho.
 */
export function PermissionCard({ ask, terminal }: { ask: PendingAsk; terminal: boolean }) {
  const { t } = useTranslation();
  const now = useNow(true);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [expanded, setExpanded] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const replyButtonRef = useRef<HTMLButtonElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const pattern = ask.risk === "high" ? null : suggestPattern(ask);
  const detail = ask.detail || t("chat.permission.noDetail");
  const long = detail.length > LONG_CHARS || detail.split("\n").length > LONG_LINES;

  useEffect(() => {
    if (replying) replyRef.current?.focus();
  }, [replying]);

  // O pedido novo (ou um outro) leva o foco para Permitir; quem digita no composer ou no terminal não o perde.
  useEffect(() => {
    if (typingIn(document.activeElement)) return;
    allowRef.current?.focus({ preventScroll: true });
  }, [ask.id]);

  // N nega e ⏎ permite, com o foco fora de um campo (o composer, o terminal) e de outro botão.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || replying || typingIn(e.target)) return;
      // Na caixa de permissões as teclas são dela (o pedido em foco).
      if ((e.target as HTMLElement | null)?.closest?.("[data-permissions-inbox]")) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        answerAsk(ask, "deny");
      } else if (e.key === "Enter" && !isInteractive(e.target) && !(e.target as HTMLElement | null)?.closest?.("[data-permission-command]")) {
        e.preventDefault();
        answerAsk(ask, "allow");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, replying]);

  const closeReply = () => {
    setReplying(false);
    // O foco volta para o botão (a caixa some e o foco cairia no corpo da página).
    replyButtonRef.current?.focus({ preventScroll: true });
  };
  const sendReply = () => {
    if (!reply.trim()) return;
    answerAsk(ask, "deny", reply);
    setReply("");
    setReplying(false);
  };

  return (
    <section role="group" aria-label={t("chat.permission.label")} data-permission-dock
      className="mb-2 rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-surface-raised shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-2.5 text-chat-note">
        <PadlockIcon className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">{t(ASK_TITLE[ask.kind], { agent: ask.agentLabel })}</span>
        <TeamRoleTag conversation={ask.conversation} />
        <span className="flex-1" />
        <span className="shrink-0 text-chat-caption text-gray-400 dark:text-white/40">{t("chat.permission.ago", { time: formatElapsed(now - ask.atMs) })}</span>
      </div>
      <div className="px-3 pt-2 pb-2.5 flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <code tabIndex={0} data-permission-command
            className={`block ${expanded ? "max-h-64" : "max-h-24"} overflow-auto cc-scroll px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/[0.06] font-mono text-chat-code whitespace-pre-wrap break-words text-gray-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70`}>
            {detail}
          </code>
          {long && (
            <button type="button" aria-expanded={expanded} data-expand onClick={() => setExpanded((v) => !v)}
              className="self-start rounded px-1 text-chat-caption text-gray-500 dark:text-white/50 hover:text-gray-800 dark:hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70">
              {expanded ? t("chat.permission.collapse") : t("chat.permission.expand")}
            </button>
          )}
        </div>
        <AskMeta ask={ask} />
        {replying && (
          <div className="flex flex-col gap-1.5">
            <label className="sr-only" htmlFor={`reply-${ask.id}`}>{t("chat.permission.replyLabel")}</label>
            <textarea id={`reply-${ask.id}`} ref={replyRef} rows={2} value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder={t("chat.permission.replyPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendReply(); }
                if (e.key === "Escape") { e.preventDefault(); closeReply(); }
              }}
              className="w-full resize-none rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2.5 py-1.5 text-chat-note outline-none focus:ring-2 focus:ring-accent-500/70" />
            <div className="flex justify-end gap-1.5">
              <button type="button" className={BTN} onClick={closeReply}>{t("btn.cancel")}</button>
              <button type="button" disabled={!reply.trim()} onClick={sendReply}
                className="h-7 px-3 rounded-lg bg-accent-600 text-white text-chat-note font-medium hover:bg-accent-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70 focus-visible:ring-offset-1">
                {t("chat.permission.sendReply")}
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => answerAsk(ask, "deny")} className={`${BTN} text-red-700 dark:text-red-400`}>
            {t("chat.permission.deny")}<Kbd>N</Kbd>
          </button>
          <button ref={replyButtonRef} type="button" onClick={() => (replying ? closeReply() : setReplying(true))} aria-expanded={replying} className={BTN}>
            {t("chat.permission.reply")}
          </button>
          <span className="flex-1" />
          {pattern && (
            <button type="button" onClick={() => alwaysAllow(ask, pattern)} title={t("chat.permission.alwaysHint")} className={`${BTN} min-w-0 max-w-full`}>
              <span className="shrink-0">{t("chat.permission.always")}</span>&nbsp;<span className="font-mono text-chat-caption truncate">{pattern}</span>
            </button>
          )}
          <button ref={allowRef} type="button" onClick={() => answerAsk(ask, "allow")}
            className="h-7 px-3 inline-flex items-center rounded-lg bg-accent-600 text-white text-chat-note font-medium hover:bg-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/70 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-surface-raised">
            {t("chat.permission.allow")}<Kbd onPrimary>⏎</Kbd>
          </button>
        </div>
        <p title={terminal ? t("chat.permission.noteTerminal") : undefined} className="m-0 truncate text-chat-caption text-gray-400 dark:text-white/40">
          {terminal ? t("chat.permission.noteTerminal") : t("chat.permission.note")}
        </p>
      </div>
    </section>
  );
}

/** O acorde da caixa de permissões como a pessoa o digita (⇧⌘A no macOS). */
export const INBOX_SHORTCUT = DESKTOP_OS === "macos" ? "⇧⌘A" : "Ctrl+Shift+A";
