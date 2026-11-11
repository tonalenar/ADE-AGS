import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useChatLive } from "@/features/chat/liveStore";
import { noticesBetween, noticeStatesOf, type ConversationNotice, type NoticeKind, type NoticeState } from "@/features/chat/noticeRules";
import { useStructured } from "@/features/chat/structured/store";
import { useConversations, useSelectedRef } from "@/features/chat/unified/useConversations";
import { useInAppNotices } from "@/features/settings/inAppNoticesPreference";
import { AlertaToast } from "@/shared/ui/alerts";

const NOTICE_TEXT_KEY = {
  approval: "chat.notice.approval",
  question: "chat.notice.question",
  failed: "chat.notice.failed",
  done: "chat.notice.done",
} as const satisfies Record<NoticeKind, string>;

const NOTICE_ICON = {
  approval: "warning",
  question: "question",
  failed: "error",
  done: "success",
} as const satisfies Record<NoticeKind, "warning" | "question" | "error" | "success">;

/** Quanto tempo o aviso fica na tela. */
const NOTICE_MS = 5000;

/**
 * Ouve as conversas e avisa, no canto, quando outra termina, falha ou pede a sua vez. Só com a janela em
 * foco: sem foco, o sistema cuida das missões (`notifier.rs`). A conversa à vista não avisa. Não desenha nada.
 *
 * Montado uma vez na casca do app, para valer em Chat, Abas e Canvas.
 */
export function InAppNotices() {
  const { t } = useTranslation();
  const enabled = useInAppNotices();
  const selectedRef = useSelectedRef();
  const conversations = useConversations();
  const phase = useChatLive((s) => s.phase);
  const question = useChatLive((s) => s.question);
  const awaiting = useChatLive((s) => s.awaiting);
  const threads = useStructured((s) => s.live);
  const states = useMemo(
    () => noticeStatesOf(conversations.map((c) => c.ref), { phase, question, awaiting }, threads),
    [conversations, phase, question, awaiting, threads],
  );
  const previous = useRef<Record<string, NoticeState>>({});

  useEffect(() => {
    const before = previous.current;
    previous.current = states;
    if (!enabled || !document.hasFocus()) return;
    const notices: ConversationNotice[] = noticesBetween(before, states, selectedRef);
    for (const notice of notices) {
      const title = conversations.find((c) => c.ref === notice.ref)?.title ?? "";
      void AlertaToast(title, t(NOTICE_TEXT_KEY[notice.kind]), NOTICE_ICON[notice.kind], NOTICE_MS);
    }
  }, [states, selectedRef, enabled, conversations, t]);

  return null;
}
