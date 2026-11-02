import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { chatPoolAccept, chatPoolDismiss, chatPoolPending, type ChatPoolPending } from "@/features/accounts/chatPool";

import { agentSwitchOf } from "./agentSwitch";
import { noticeDetail } from "./timelineModel";
import type { TimelineItem } from "./types";

/**
 * Um aviso do app no fio: a sessão que não voltou (o agente recomeçou sem o histórico), a mensagem que saiu da
 * fila sem ser enviada (com «Reenviar»), uma opção que o agente não aplicou, ou a troca de agente («Agora com
 * Codex»). A frase vem do código; o motivo, do item.
 */
export function NoticeRow({ item, onResend, threadId }: { item: TimelineItem; onResend?: (text: string) => void; threadId?: string }) {
  const { t } = useTranslation();
  const change = agentSwitchOf(item);
  if (change) {
    return (
      <div role="status" className="flex flex-col gap-1 px-1 text-chat-note text-gray-600 dark:text-white/60 border-t border-b border-gray-200 dark:border-white/[0.08] py-2">
        <p className="m-0 font-medium text-gray-900 dark:text-white">
          {change.model ? t("chat.timeline.notice.agentSwitchModel", { agent: change.toLabel, model: change.model }) : t("chat.timeline.notice.agentSwitch", { agent: change.toLabel })}
        </p>
        <p className="m-0">{t(change.strategy === "delta" ? "chat.timeline.notice.agentSwitchDelta" : "chat.timeline.notice.agentSwitchFull", { agent: change.toLabel, from: change.fromLabel })}</p>
        {change.noApproval && <p className="m-0 text-amber-700 dark:text-amber-400">{t("chat.timeline.notice.agentSwitchNoApproval", { agent: change.toLabel })}</p>}
        {change.accessChanged && <p className="m-0 text-amber-700 dark:text-amber-400">{t("chat.timeline.notice.agentSwitchAccess", { agent: change.toLabel })}</p>}
      </div>
    );
  }
  const code = item.label ?? "";
  if (code.startsWith("pool")) return <PoolNotice item={item} threadId={threadId} />;
  const known = code === "resumeLost" || code === "queueDropped" || code === "optionIgnored";
  const detail = noticeDetail(item);
  return (
    <div role="status" className="flex flex-col gap-1 px-1 text-chat-note text-amber-700 dark:text-amber-400">
      <p className="m-0 font-medium">{known ? t(`chat.timeline.notice.${code}`) : detail}</p>
      {known && detail && (
        <p className={`m-0 break-words text-gray-600 dark:text-white/60 ${code === "queueDropped" ? "italic" : ""}`}>{detail}</p>
      )}
      {code === "queueDropped" && onResend && detail && (
        <button type="button" onClick={() => onResend(detail)}
          className="self-start h-6 px-2 rounded-md border border-gray-200 dark:border-white/10 text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
          {t("chat.timeline.notice.resend")}
        </button>
      )}
    </div>
  );
}

/**
 * Os avisos do pool de contas (`conversa::pool`): a troca que aconteceu, a que não foi possível e as duas perguntas
 * («Continuar na outra conta?», «Voltar à original?»). A frase com os nomes das contas vem do backend; o título e os
 * botões, do catálogo. Os botões só aparecem enquanto a pergunta continua pendente.
 */
function PoolNotice({ item, threadId }: { item: TimelineItem; threadId?: string }) {
  const { t } = useTranslation();
  const code = item.label ?? "";
  const asks = code === "poolAsk" || code === "poolReturnAsk";
  const [pending, setPending] = useState<ChatPoolPending | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!asks || !threadId) return;
    let alive = true;
    chatPoolPending(threadId).then((p) => alive && setPending(p), () => {});
    return () => { alive = false; };
  }, [asks, threadId]);

  const accept = () => {
    if (!threadId) return;
    setPending(null);
    chatPoolAccept(threadId).catch((e) => setError(String(e)));
  };
  const dismiss = () => {
    if (!threadId) return;
    setPending(null);
    chatPoolDismiss(threadId).catch((e) => setError(String(e)));
  };
  const button = "h-6 px-2 rounded-md border border-gray-200 dark:border-white/10 text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.06]";
  return (
    <div role="status" className="flex flex-col gap-1 px-1 text-chat-note text-amber-700 dark:text-amber-400">
      <p className="m-0 font-medium">{t(`chat.timeline.notice.${code}`, { defaultValue: code })}</p>
      {item.text && <p className="m-0 break-words text-gray-600 dark:text-white/60">{item.text}</p>}
      {asks && pending && (
        <div className="flex gap-2">
          <button type="button" onClick={accept} className={button}>
            {t(pending.kind === "return" ? "chat.timeline.notice.poolReturnAccept" : "chat.timeline.notice.poolAccept")}
          </button>
          <button type="button" onClick={dismiss} className={button}>{t("chat.timeline.notice.poolDismiss")}</button>
        </div>
      )}
      {error && <p role="alert" className="m-0 text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
