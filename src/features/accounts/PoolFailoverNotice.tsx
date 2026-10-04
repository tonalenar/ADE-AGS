import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { useAccountsStore } from "@/features/accounts/store";
import { useRunsStore } from "@/features/runs/store";
import { showBotToast } from "@/shared/brand/botToastStore";
import type { BusEvent } from "@/shared/bus";

/**
 * Tópico do bus (ver `src/shared/bus.ts`) do item 6 da missão de failover de pools: o Backend
 * publica isso quando uma tarefa headless (flota) já trocou de conta dentro de um pool com
 * `failover: true`. É um aviso do que JÁ aconteceu (auditoria), não uma sugestão preventiva —
 * terminais interativos (TUI) continuam sem nenhum aviso automático (o Backend não achou um
 * jeito seguro de detectar isso numa TUI; ver docs/ade-ags/POOL_FAILOVER.md).
 */
export const POOL_FAILOVER_TOPIC = "account.pool_failover";

export interface PoolFailoverEvent {
  taskId: string;
  runId: string;
  poolId: string;
  poolName: string;
  /** `null` = conta principal/do sistema. */
  fromAccount: string | null;
  /** `null` = conta principal/do sistema. */
  toAccount: string | null;
  reason: string;
  kind: "rate_limited" | string;
}

/**
 * Já existe aviso por notificação do SO (`notifier.rs`); isto é o espelho dentro do app — um
 * toast dizendo que tarefa trocou de conta, em qual pool e por quê. Monta uma vez (ver
 * `AppShell.tsx`), do lado dos outros avisos de canto.
 */
export function PoolFailoverNotice() {
  const { t } = useTranslation();

  useEffect(() => {
    const off = listen<BusEvent>("ade-event", (e) => {
      if (e.payload.topic !== POOL_FAILOVER_TOPIC) return;
      const data = e.payload.data as unknown as PoolFailoverEvent | undefined;
      if (!data?.poolId) return;
      const task = useRunsStore.getState().tasks.find((tk) => tk.id === data.taskId);
      const accounts = useAccountsStore.getState().accounts;
      const accountLabel = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.name ?? id : t("accounts.system"));
      showBotToast({
        title: data.poolName || t("accounts.pools.title"),
        text: t("accounts.pools.failover.notice", {
          task: task?.title ?? data.taskId,
          from: accountLabel(data.fromAccount),
          to: accountLabel(data.toAccount),
          pool: data.poolName,
        }),
        ms: 8000,
      });
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [t]);

  return null;
}
