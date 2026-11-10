import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_PENDING_CAPTURES, rememberPendingCapture } from "@/features/chat/attachments/pendingCaptures";
import { attachToComposer } from "@/features/chat/store";
import { CameraIcon } from "@/features/chat/chatIcons";
import { AlertaToast } from "@/shared/ui/alerts";

import { desktopScreenshot } from "./ipc";
import { SnapshotTargetPicker } from "./SnapshotTargetPicker";
import { MAIN_TARGET, SNAPSHOT_DEFAULT_EVENT, targetValue, type SnapshotTarget } from "./snapshotTargets";

/**
 * Captura o que o seletor mostra (padrão: a tela principal) e põe a imagem no rascunho atual.
 * Antes de anexar, guarda a captura como pendente: ela sobrevive a trocar de conversa ou recarregar até ser enviada.
 * O atalho `Cmd+Shift+S` pede a captura padrão, sem mudar a escolha do seletor. Depois de uma captura feita pelo
 * botão, o seletor volta para a tela principal.
 */
export function DesktopSnapshotButton({ className = "", target = null, disabled = false }: { className?: string; target?: string | null; disabled?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<SnapshotTarget>(MAIN_TARGET);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const macOS = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

  const capture = async (requested: SnapshotTarget) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const path = await desktopScreenshot(requested);
      const { dropped } = rememberPendingCapture({ path, target, kind: "snapshot" });
      attachToComposer([path], target);
      void AlertaToast(t("screenRecording.snapshot"), t("screenRecording.snapshotDone"), "success", 3000);
      if (dropped) void AlertaToast(t("screenRecording.snapshot"), t("screenRecording.pendingDropped", { max: MAX_PENDING_CAPTURES }), "warning", 6000);
      setChoice((current) => (targetValue(current) === targetValue(requested) ? MAIN_TARGET : current));
    } catch (error) {
      void AlertaToast(t("screenRecording.snapshot"), String(error), "error", 5000);
    } finally {
      setBusy(false);
    }
  };

  // O atalho chega por evento no mesmo botão: a captura é a mesma, só o alvo é sempre o padrão.
  const captureRef = useRef(capture);
  captureRef.current = capture;
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;
    const onDefault = () => { void captureRef.current(MAIN_TARGET); };
    button.addEventListener(SNAPSHOT_DEFAULT_EVENT, onDefault);
    return () => button.removeEventListener(SNAPSHOT_DEFAULT_EVENT, onDefault);
  }, [macOS]);

  if (!macOS) return null;
  const title = choice.kind === "main" ? t("screenRecording.snapshotHint") : t("screenRecording.snapshotHintChoice");
  return (
    <>
      <SnapshotTargetPicker value={choice} onChange={setChoice} disabled={busy || disabled} />
      <button ref={buttonRef} type="button" className={className} disabled={busy || disabled} title={title} aria-label={title} data-chat-desktop-snapshot=""
        onClick={() => { void capture(choice); }}>
        <CameraIcon className="w-4 h-4" />
        <span className="sr-only">{t("screenRecording.snapshot")}</span>
      </button>
    </>
  );
}
