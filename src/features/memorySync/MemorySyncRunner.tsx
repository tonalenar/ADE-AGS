import { useEffect, useRef } from "react";

import { useTabsStore } from "@/features/tabs/store";

import { useMemorySyncStore } from "./store";
import type { MemorySyncStatus } from "./types";

const INITIAL_DELAY_MS = 10_000;
const RETRY_DELAY_MS = 5 * 60_000;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168;

/** Calcula em ms quando o próximo envio automático de memória deve rodar, ou `null` se desligado. */
export function msUntilNextMemorySync(
  status: MemorySyncStatus | null,
  nowMs: number,
  lastAttemptMs: number | null,
): number | null {
  if (!status || !status.enabled || !status.configured || !status.autoEnabled) {
    return null;
  }
  const hours = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, status.intervalHours || 6));
  const intervalMs = hours * 3600_000;
  const lastDoneMs = status.last ? status.last.at * 1000 : null;
  const referenceMs =
    lastDoneMs !== null && lastAttemptMs !== null
      ? Math.max(lastDoneMs, lastAttemptMs)
      : (lastDoneMs ?? lastAttemptMs);
  if (referenceMs === null) {
    return INITIAL_DELAY_MS;
  }
  const elapsedMs = Math.max(0, nowMs - referenceMs);
  const waitMs = Math.max(0, intervalMs - elapsedMs);
  // Se houve erro recente depois do último envio bem-sucedido, aguarda o intervalo de retry.
  if (status.lastError && lastAttemptMs !== null && lastDoneMs !== null && lastAttemptMs > lastDoneMs) {
    return Math.max(waitMs, Math.max(0, RETRY_DELAY_MS - Math.max(0, nowMs - lastAttemptMs)));
  }
  return waitMs;
}

/**
 * Agendador opcional em segundo plano para envio automático periódico das memórias
 * quando `enabled`, `configured` e `autoEnabled` estão ligados. Nunca roda enquanto desligado.
 */
export function MemorySyncRunner() {
  const status = useMemorySyncStore((s) => s.status);
  const running = useMemorySyncStore((s) => s.running);
  const load = useMemorySyncStore((s) => s.load);
  const syncNow = useMemorySyncStore((s) => s.syncNow);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const activeCwd = useTabsStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? s.tabs[0]?.cwd ?? "",
  );

  const lastAttemptRef = useRef<number | null>(null);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  useEffect(() => {
    if (running) return;
    const delayMs = msUntilNextMemorySync(status, Date.now(), lastAttemptRef.current);
    if (delayMs === null) return;
    const timer = window.setTimeout(() => {
      lastAttemptRef.current = Date.now();
      void syncNow(workspaceId, activeCwd);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [status, running, workspaceId, activeCwd, syncNow]);

  return null;
}
