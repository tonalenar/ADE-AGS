import { useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_PENDING_CAPTURES, rememberPendingCapture } from "@/features/chat/attachments/pendingCaptures";
import { attachToComposer } from "@/features/chat/store";
import { CameraIcon } from "@/features/chat/chatIcons";
import { AlertaToast } from "@/shared/ui/alerts";

import { desktopScreenshot } from "./ipc";

/**
 * Captura pontualmente o display principal do Mac e põe a imagem no rascunho atual.
 * Antes de anexar, guarda a captura como pendente: ela sobrevive a trocar de conversa ou recarregar até ser enviada.
 */
export function DesktopSnapshotButton({ className = "", target = null, disabled = false }: { className?: string; target?: string | null; disabled?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const macOS = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

  const capture = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const path = await desktopScreenshot();
      const { dropped } = rememberPendingCapture({ path, target, kind: "snapshot" });
      attachToComposer([path], target);
      void AlertaToast(t("screenRecording.snapshot"), t("screenRecording.snapshotDone"), "success", 3000);
      if (dropped) void AlertaToast(t("screenRecording.snapshot"), t("screenRecording.pendingDropped", { max: MAX_PENDING_CAPTURES }), "warning", 6000);
    } catch (error) {
      void AlertaToast(t("screenRecording.snapshot"), String(error), "error", 5000);
    } finally {
      setBusy(false);
    }
  };

  const title = t("screenRecording.snapshotHint");
  if (!macOS) return null;
  return (
    <button type="button" className={className} disabled={busy || disabled} title={title} aria-label={title} data-chat-desktop-snapshot=""
      onClick={() => { void capture(); }}>
      <CameraIcon className="w-4 h-4" />
      <span className="sr-only">{t("screenRecording.snapshot")}</span>
    </button>
  );
}
