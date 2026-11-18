import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useChatLive } from "@/features/chat/liveStore";
import { useCanvasStore } from "@/features/canvas/store";
import { noticesBetween, noticeStatesOf, type ConversationNotice, type NoticeKind, type NoticeState } from "@/features/chat/noticeRules";
import { threadIdOf, threadStatusSignature } from "@/features/chat/structured/model";
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
 * Abre a conversa do aviso pela seleção única (`selectConversation`), que cobre a aba de TUI e a conversa por
 * protocolo (`thread:<id>`). Carregada no clique, e não no import: o aviso não puxa o canvas para o entry da casca.
 */
export async function abrirConversaDoAviso(ref: string): Promise<void> {
  const { selectConversation } = await import("@/features/chat/unified/selectionActions");
  selectConversation(ref);
}

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
  // Só a fase, os pedidos e a falha das conversas da central disparam o cálculo; o texto que chega numa delas não.
  const threadIds = useMemo(() => conversations.map((c) => threadIdOf(c.ref)).filter((id): id is string => id !== null), [conversations]);
  const liveSignature = useStructured((s) => threadStatusSignature(s.live, threadIds));
  const canvasLoadError = useCanvasStore((s) => s.loadError);
  const canvasSaveError = useCanvasStore((s) => s.saveError);
  const states = useMemo(
    () => noticeStatesOf(conversations.map((c) => c.ref), { phase, question, awaiting }, useStructured.getState().live),
    [conversations, phase, question, awaiting, liveSignature],
  );
  const previous = useRef<Record<string, NoticeState>>({});

  useEffect(() => {
    const before = previous.current;
    previous.current = states;
    if (!enabled || !document.hasFocus()) return;
    const notices: ConversationNotice[] = noticesBetween(before, states, selectedRef);
    for (const notice of notices) {
      const title = conversations.find((c) => c.ref === notice.ref)?.title ?? "";
      void AlertaToast(title, t(NOTICE_TEXT_KEY[notice.kind]), NOTICE_ICON[notice.kind], NOTICE_MS, "top-end", {
        label: t("chat.inbox.open"),
        onClick: () => {
          abrirConversaDoAviso(notice.ref).catch((error: unknown) => console.error("[aviso] não foi possível abrir a conversa", error));
        },
      });
    }
  }, [states, selectedRef, enabled, conversations, t]);

  useEffect(() => {
    if (canvasLoadError) {
      void AlertaToast(t("canvas.title"), t("canvas.loadError", { error: canvasLoadError }), "error", 15000);
    }
  }, [canvasLoadError, t]);

  useEffect(() => {
    if (canvasSaveError) {
      void AlertaToast(t("canvas.title"), t("canvas.saveError", { error: canvasSaveError }), "error", 10000);
    }
  }, [canvasSaveError, t]);

  return null;
}
