import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { AlertaToast } from "neogestify-ui-components";

import type { BusEvent } from "@/shared/bus";

/**
 * Tópico tentativo do bus (ver `src/shared/bus.ts`) pro aviso do item 5 da missão de failover
 * de pools: o Backend publica isso quando a conta de uma TUI interativa esgota e pertence a um
 * pool com `failover: true`. Nome e payload ainda não confirmados pelo Backend — ajustar aqui
 * quando ele fechar (ver docs/ade-ags/POOL_FAILOVER.md).
 */
export const POOL_SUGGESTION_TOPIC = "account.pool_suggestion";

export interface PoolSuggestionPayload {
  accountKey: string;
  poolId: string;
  poolName: string;
  suggestedAccount: string;
}

/**
 * Terminais interativos (TUI) nunca trocam de conta sozinhos: a tab tem sessão própria. Isso só
 * mostra um toast sugerindo trocar pra outra conta do mesmo pool — a decisão fica com quem usa.
 * Monta uma vez no app (ver `AppShell.tsx`), do lado dos outros avisos de canto.
 */
export function PoolFailoverNotice() {
  const { t } = useTranslation();

  useEffect(() => {
    const off = listen<BusEvent>("ade-event", (e) => {
      if (e.payload.topic !== POOL_SUGGESTION_TOPIC) return;
      const data = e.payload.data as unknown as PoolSuggestionPayload | undefined;
      if (!data?.accountKey || !data.suggestedAccount) return;
      AlertaToast(
        data.poolName || t("accounts.pools.title"),
        t("accounts.pools.failover.notice", { from: data.accountKey, to: data.suggestedAccount, pool: data.poolName }),
        "info",
        8000,
      );
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [t]);

  return null;
}
