import type { TFunction } from "i18next";

import type { ChatPoolPending } from "@/features/accounts/chatPool";

import type { TimelineItem } from "./types";

/** Correspondência estrita entre o código do aviso na timeline e o `pending.kind` que ele aceita. */
export const POOL_NOTICE_PENDING_KIND: Record<string, ChatPoolPending["kind"]> = {
  poolAsk: "switch",
  poolReturnAsk: "return",
  poolOffer: "join",
  fallbackOffer: "fallback",
};

/** O aviso só exibe ações quando seu código corresponde ao tipo de pendência ativa da conversa. Pura. */
export function matchesPoolPending(code: string, pending: ChatPoolPending | null): boolean {
  const expected = POOL_NOTICE_PENDING_KIND[code];
  return expected !== undefined && pending?.kind === expected;
}

/** O último aviso interativo de pool/fallback da lista de turnos (só ele pode exibir botões ativos). Pura. */
export function latestInteractivePoolNoticeId(items: readonly (TimelineItem | null | undefined)[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && item.kind === "notice" && item.label && item.label in POOL_NOTICE_PENDING_KIND) {
      return item.id;
    }
  }
  return null;
}

interface PoolNoticePayload {
  kind?: string;
  from?: string;
  to?: string;
  pool?: string;
  resetsAt?: string;
  reason?: string;
  reasonCode?: string;
  max?: number;
}

function parsePayload(text: string | undefined): PoolNoticePayload | null {
  if (!text || !text.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PoolNoticePayload) : null;
  } catch {
    return null;
  }
}

/**
 * Formata o corpo de um aviso de pool/conta (`conversa/pool.rs`):
 * - Payload JSON estruturado → traduzido pelos 3 catálogos (`pt-BR`, `en`, `es`).
 * - Texto plano legado (gravado antes da estruturação) → exibido como está, sem perda.
 */
export function formatPoolNoticeText(code: string, text: string | undefined, t: TFunction): string | null {
  if (!text) return null;
  const payload = parsePayload(text);
  if (!payload) return text;

  switch (code) {
    case "poolOffer":
      if (typeof payload.from === "string" && typeof payload.pool === "string") {
        return t("chat.timeline.notice.poolOfferBody", { from: payload.from, pool: payload.pool });
      }
      return text;
    case "poolBlocked": {
      if (payload.kind === "failed" && typeof payload.reason === "string") {
        return t("chat.timeline.notice.poolSwitchFailedBody", { reason: payload.reason });
      }
      if (typeof payload.from === "string") {
        const reason =
          payload.reasonCode === "chained"
            ? t("chat.timeline.notice.poolBlockedChained")
            : payload.reasonCode === "hourlyLimit" && typeof payload.max === "number"
              ? t("chat.timeline.notice.poolBlockedHourly", { max: payload.max })
              : typeof payload.reason === "string"
                ? payload.reason
                : "";
        if (reason) return t("chat.timeline.notice.poolBlockedBody", { from: payload.from, reason });
      }
      return text;
    }
    case "poolAsk":
      if (typeof payload.from === "string" && typeof payload.to === "string" && typeof payload.resetsAt === "string") {
        return t("chat.timeline.notice.poolAskBody", { from: payload.from, to: payload.to, resetsAt: payload.resetsAt });
      }
      return text;
    case "poolSwitch":
      if (typeof payload.from === "string" && typeof payload.to === "string" && typeof payload.resetsAt === "string") {
        return t("chat.timeline.notice.poolSwitchBody", { from: payload.from, to: payload.to, resetsAt: payload.resetsAt });
      }
      return text;
    case "poolReturnAsk":
      if (typeof payload.to === "string") {
        return t("chat.timeline.notice.poolReturnAskBody", { to: payload.to });
      }
      return text;
    case "poolReturn":
      if (typeof payload.to === "string") {
        return t("chat.timeline.notice.poolReturnBody", { to: payload.to });
      }
      return text;
    case "accountSwitch":
      if (typeof payload.to === "string") {
        return t("chat.timeline.notice.accountSwitchBody", { to: payload.to });
      }
      return text;
    default:
      return text;
  }
}
