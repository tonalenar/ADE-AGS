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

  const warnings = status?.warnings ?? [];
  if (!status || status.phase === "idle" || (status.phase === "synced" && warnings.length === 0)) return null;

  const failed = status.phase === "failed";
  return (
    <div role={failed ? "alert" : "status"} className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[11.5px] leading-4 ${failed ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-amber-500/10 text-amber-800 dark:text-amber-200"}`}>
      <div className="min-w-0 flex-1">
        {status.phase !== "synced" && (
          <p>
            {failed
              ? t("memoryInbox.syncFailed", { error: status.error ?? "" })
              : status.phase === "syncing"
                ? t("memoryInbox.syncing")
                : t("memoryInbox.syncQueued")}
          </p>
        )}
        {warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>
      {failed && (
        <button type="button" onClick={() => { void memoryIpc.retryRepoSync(workspaceId).then(apply).catch(() => undefined); }}
          className="h-6 rounded-md bg-red-600 px-2.5 text-[11px] font-medium text-white hover:bg-red-500">
          {t("memoryInbox.syncRetry")}
        </button>
      )}
    </div>
  );
}
