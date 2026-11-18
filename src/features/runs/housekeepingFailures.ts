import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { AlertaToast } from "@/shared/ui/alerts";

/**
 * Avisa quando a limpeza de arranque não sobe: a frota é liberada, mas a varredura não rodou.
 */
export function useHousekeepingFailures(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const subscription = listen<string>("cc-housekeeping-failed", (event) => {
      const error = event.payload;
      void AlertaToast(
        t("runs.housekeepingFailedTitle"),
        t("runs.housekeepingFailed", { error }),
        "error",
        8000,
      );
    });
    return () => {
      subscription.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [t]);
}
