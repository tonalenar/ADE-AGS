import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { AlertaToast } from "@/shared/ui/alerts";

import type { RepoSyncStatus } from "./types";

/**
 * Avisa uma vez quando a exportação do repositório de memória falha, em qualquer tela.
 * O painel de memória continua mostrando a fila; o toast só não se repete para o mesmo erro.
 */
export function useRepoSyncFailures(): void {
  const { t } = useTranslation();
  const avisados = useRef(new Set<string>());
  useEffect(() => {
    const subscription = listen<RepoSyncStatus>("cc-memory-repo-sync", (event) => {
      const { workspaceId, phase, error } = event.payload;
      if (phase !== "failed" || !error) return;
      const chave = `${workspaceId}:${error}`;
      if (avisados.current.has(chave)) return;
      avisados.current.add(chave);
      void AlertaToast(
        t("memoryInbox.syncFailedTitle"),
        t("memoryInbox.syncFailed", { error }),
        "error",
        8000,
      );
    });
    return () => {
      subscription.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [t]);
}
