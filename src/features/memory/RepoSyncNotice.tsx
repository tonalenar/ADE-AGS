import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import * as memoryIpc from "./ipc";
import type { RepoSyncStatus } from "./types";

/**
 * Mostra a fila de exportação do repositório Markdown. A aprovação já está no banco;
 * falha de git não a desfaz e continua visível até um retry conseguir.
 */
export function RepoSyncNotice({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RepoSyncStatus | null>(null);

  const apply = useCallback((next: RepoSyncStatus) => {
    setStatus((current) => (current?.workspaceId === next.workspaceId || next.workspaceId === workspaceId ? next : current));
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    setStatus(null);
    memoryIpc.getRepoSyncStatus(workspaceId)
      .then((next) => { if (alive) setStatus((current) => current ?? next); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [workspaceId]);

  useEffect(() => {
    const subscription = listen<RepoSyncStatus>("cc-memory-repo-sync", (event) => {
      if (event.payload.workspaceId === workspaceId) apply(event.payload);
    });
    return () => { subscription.then((unlisten) => unlisten()).catch(() => undefined); };
  }, [workspaceId, apply]);

  if (!status || status.phase === "idle" || status.phase === "synced") return null;

  const failed = status.phase === "failed";
  return (
    <div role={failed ? "alert" : "status"} className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-[11.5px] ${failed ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300" : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"}`}>
      <p className="min-w-0 flex-1">
        {failed
          ? t("memoryInbox.syncFailed", { error: status.error ?? "" })
          : status.phase === "syncing"
            ? t("memoryInbox.syncing")
            : t("memoryInbox.syncQueued")}
      </p>
      {failed && (
        <button type="button" onClick={() => { void memoryIpc.retryRepoSync(workspaceId).then(apply).catch(() => undefined); }}
          className="rounded border border-red-600 px-2 py-0.5 text-[11px] font-medium">
          {t("memoryInbox.syncRetry")}
        </button>
      )}
    </div>
  );
}
