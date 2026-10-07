import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { listDeletedMemoryWorkspaces, restoreMemoryWorkspace } from "@/features/memory/ipc";
import type { DeletedMemoryWorkspace } from "@/features/memory/types";
import { isExpiringSoon, remainingDays } from "./deleteWorkspaceFlow";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; items: DeletedMemoryWorkspace[] };

/** Workspaces na lixeira (soft-delete de 30 dias) com o prazo restante e o botão Restaurar. */
export function DeletedWorkspacesList({ onRestored }: { onRestored?: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    listDeletedMemoryWorkspaces()
      .then((items) => setState({ status: "ready", items: Array.isArray(items) ? items : [] }))
      .catch(() => setState({ status: "error" }));
  }, []);

  useEffect(load, [load]);

  const restore = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await restoreMemoryWorkspace(id);
      onRestored?.();
      load();
    } catch (e) {
      setError(t("workspaceDelete.restoreFailed", { detail: String(e) }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="mt-8" aria-label={t("workspaceDelete.deletedTitle")} aria-busy={state.status === "loading"}>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-400 dark:text-white/40">
        {t("workspaceDelete.deletedTitle")}
      </h2>
      {state.status === "loading" && <p role="status" className="text-xs text-gray-400">{t("workspaceDelete.loading")}</p>}
      {state.status === "error" && (
        <p role="alert" className="text-xs text-red-500 dark:text-red-400">
          {t("workspaceDelete.listFailed")}{" "}
          <Button variant="outline" onClick={load}>{t("workspaceDelete.retry")}</Button>
        </p>
      )}
      {error && <p role="alert" className="mb-2 text-xs text-red-500 dark:text-red-400">{error}</p>}
      {state.status === "ready" && state.items.length === 0 && (
        <p className="text-xs italic text-gray-400 dark:text-gray-500">{t("workspaceDelete.deletedEmpty")}</p>
      )}
      {state.status === "ready" && state.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {state.items.map((w) => {
            const days = remainingDays(w.remainingSeconds);
            const soon = isExpiringSoon(days);
            return (
              <li key={w.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-800/50">
                <span className="min-w-0 truncate text-sm text-gray-800 dark:text-gray-100">
                  {w.name}{" "}
                  <span className={`ml-1 rounded-full border px-2 py-px text-[11px] ${soon ? "border-red-500/60 text-red-600 dark:text-red-400" : "border-amber-500/60 text-amber-700 dark:text-amber-400"}`}>
                    {days === null ? t("workspaceDelete.noDeadline") : t("workspaceDelete.remaining", { count: days })}
                  </span>
                </span>
                <Button variant="outline" disabled={busyId !== null} onClick={() => void restore(w.id)} aria-label={t("workspaceDelete.restoreAria", { name: w.name })}>
                  {t("workspaceDelete.restore")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
