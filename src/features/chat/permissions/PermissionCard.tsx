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

/**
 * O pedido de permissão no fio da conversa (prancheta 14): cabeçalho âmbar com o cadeado e o tempo,
 * o comando (ou os arquivos) numa caixa mono, onde e o que mexe, e Negar (N), Responder…, "Sempre
 * permitir <padrão>" e Permitir (⏎). Responder nega e manda o texto ao agente. Risco alto não
 * oferece regra: nunca é permitido sozinho.
 */
export function PermissionCard({ ask, terminal }: { ask: PendingAsk; terminal: boolean }) {
  const { t } = useTranslation();
  const now = useNow(true);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const pattern = ask.risk === "high" ? null : suggestPattern(ask);

  useEffect(() => {
    if (replying) replyRef.current?.focus();
  }, [replying]);

  // N nega e ⏎ permite, com o foco fora de um campo (o composer, o terminal) e de outro botão.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || replying || typingIn(e.target)) return;
      // Na caixa de permissões as teclas são dela (o pedido em foco).
      if ((e.target as HTMLElement | null)?.closest?.("[data-permissions-inbox]")) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        answerAsk(ask, "deny");
      } else if (e.key === "Enter" && !isInteractive(e.target)) {
        e.preventDefault();
        answerAsk(ask, "allow");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, replying]);

  const sendReply = () => {
    if (!reply.trim()) return;
    answerAsk(ask, "deny", reply);
    setReply("");
    setReplying(false);
  };

  const button = "h-8 px-3 rounded-lg border border-gray-200 dark:border-white/10 text-chat-ui hover:bg-gray-100 dark:hover:bg-white/[0.06]";
  return (
    <div className="flex flex-col gap-3.5">
      <section aria-label={t("chat.permission.label")}
        className="rounded-[14px] border border-amber-300 dark:border-amber-400/35 bg-white dark:bg-surface-sunken overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 bg-amber-50 dark:bg-amber-400/[0.08] text-amber-800 dark:text-amber-400 text-chat-note font-medium">
          <PadlockIcon className="w-[15px] h-[15px] shrink-0" />
          <span className="min-w-0 truncate">{t(ASK_TITLE[ask.kind], { agent: ask.agentLabel })}</span>
          <TeamRoleTag conversation={ask.conversation} />
          <span className="flex-1" />
          <span className="shrink-0 font-normal">{t("chat.permission.ago", { time: formatElapsed(now - ask.atMs) })}</span>
        </div>
        <div className="px-3.5 py-3 flex flex-col gap-2">
          <code className="block px-3 py-2.5 rounded-lg bg-gray-100 dark:bg-white/[0.06] font-mono text-chat-note whitespace-pre-wrap break-words text-gray-900 dark:text-white">
            {ask.detail || t("chat.permission.noDetail")}
          </code>
          <AskMeta ask={ask} />
          {replying && (
            <div className="flex flex-col gap-1.5 pt-1">
              <label className="sr-only" htmlFor={`reply-${ask.id}`}>{t("chat.permission.replyLabel")}</label>
              <textarea id={`reply-${ask.id}`} ref={replyRef} rows={2} value={reply} onChange={(e) => setReply(e.target.value)}
                placeholder={t("chat.permission.replyPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendReply(); }
                  if (e.key === "Escape") { e.preventDefault(); setReplying(false); }
                }}
                className="w-full resize-none rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-3 py-2 text-chat-ui outline-none focus:ring-1 focus:ring-accent-500/70" />
              <div className="flex justify-end gap-1.5">
                <button type="button" className={button} onClick={() => setReplying(false)}>{t("btn.cancel")}</button>
                <button type="button" disabled={!reply.trim()} onClick={sendReply}
                  className="h-8 px-3.5 rounded-lg bg-accent-600 text-white text-chat-ui font-medium hover:bg-accent-700 disabled:opacity-50">
                  {t("chat.permission.sendReply")}
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <button type="button" onClick={() => answerAsk(ask, "deny")} className={`${button} text-red-700 dark:text-red-400`}>
              {t("chat.permission.deny")}<Kbd>N</Kbd>
            </button>
            <button type="button" onClick={() => setReplying(!replying)} aria-expanded={replying} className={button}>
              {t("chat.permission.reply")}
            </button>
            <span className="flex-1" />
            {pattern && (
              <button type="button" onClick={() => alwaysAllow(ask, pattern)} title={t("chat.permission.alwaysHint")} className={button}>
                {t("chat.permission.always")} <span className="font-mono text-chat-code">{pattern}</span>
              </button>
            )}
            <button type="button" onClick={() => answerAsk(ask, "allow")}
              className="h-8 px-3.5 rounded-lg bg-accent-600 text-white text-chat-ui font-medium hover:bg-accent-700">
              {t("chat.permission.allow")}<Kbd onPrimary>⏎</Kbd>
            </button>
          </div>
        </div>
      </section>
      <p className="m-0 px-1 text-chat-note text-gray-500 dark:text-white/45">
        {terminal ? t("chat.permission.noteTerminal") : t("chat.permission.note")}
      </p>
    </div>
  );
}

/** O acorde da caixa de permissões como a pessoa o digita (⇧⌘A no macOS). */
export const INBOX_SHORTCUT = DESKTOP_OS === "macos" ? "⇧⌘A" : "Ctrl+Shift+A";
