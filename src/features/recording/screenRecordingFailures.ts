import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { AlertaToast } from "@/shared/ui/alerts";

/**
 * Escuta a falha de finalização de gravação de tela que o backend emite (`screen-recording-error`).
 * Fica montado no app inteiro: a gravação pode ser parada na saída, com qualquer tela aberta.
 */
export function useScreenRecordingFailures(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const subscription = listen<{ id: string; erro: string }>("screen-recording-error", (event) => {
      void AlertaToast(
        t("screenRecording.title"),
        t("screenRecording.stopFailed", { error: event.payload.erro }),
        "error",
        8000,
      );
    });
    return () => {
      subscription.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [t]);
}
