import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CheckIcon, CopyIcon, UndoIcon } from "../chatIcons";
import { insertIntoComposer } from "../store";
import { relativeTime } from "./messageTime";

/**
 * As ações sob uma mensagem, como no Claude Code: a hora relativa («há 24 minutos») e os botões, que só aparecem ao
 * passar o mouse ou ao focar por teclado (nada fixo na tela). Copiar leva o texto LIMPO (sem anexos, citações nem
 * envelope). Na mensagem da pessoa, «Editar» devolve o texto ao campo de mensagem para ela mudar e reenviar (não cancela
 * nem apaga nada). Bifurcar, fixar e ler em voz alta ainda não existem no ADE: ficam para outra rodada. A hora é
 * calculada quando a linha aparece (mouse ou foco), sem relógio rodando.
 */
export function MessageActions({ text, at, editable = false, align = "start" }: { text: string; at?: number; editable?: boolean; align?: "start" | "end" }) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const when = relativeTime(at, now, i18n.language);
  if (!text.trim() && !when) return null;

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  const button = "w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white focus-visible:ring-2 focus-visible:ring-accent-500/50";
  return (
    <div data-message-actions="" onPointerEnter={() => setNow(Date.now())} onFocusCapture={() => setNow(Date.now())}
      className={`flex items-center gap-0.5 min-h-7 text-chat-caption text-gray-500 dark:text-white/45 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity ${align === "end" ? "justify-end" : ""}`}>
      {when && <span className="px-1 whitespace-nowrap">{when}</span>}
      {text.trim() && (
        <button type="button" onClick={copy} aria-label={t("chat.message.copy")} title={copied ? t("chat.message.copied") : t("chat.message.copy")} className={button}>
          {copied ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
        </button>
      )}
      {editable && text.trim() && (
        <button type="button" onClick={() => insertIntoComposer(text)} aria-label={t("chat.message.edit")} title={t("chat.message.editHint")} className={button}>
          <UndoIcon className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
