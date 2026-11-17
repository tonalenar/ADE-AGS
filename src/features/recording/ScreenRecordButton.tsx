import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_PENDING_CAPTURES, rememberPendingCapture } from "@/features/chat/attachments/pendingCaptures";
import { RecordIcon } from "@/features/chat/chatIcons";
import { attachToComposer } from "@/features/chat/store";
import { showBotToast, useBotToastStore } from "@/shared/brand/botToastStore";
import { AlertaToast } from "@/shared/ui/alerts";

import { openPrivacySettings, screenRecordingStart, screenRecordingStatus, screenRecordingStop, type RecordingSource } from "./ipc";

/** Prefixo que o backend (`screen_recording.rs`) põe no erro quando o macOS nega a Gravação de Tela. */
const PERMISSION_MARKER = "SCREEN_CAPTURE_PERMISSION_REQUIRED:";
/** Prefixo do erro em que o `devicectl` não oferece a gravação de tela deste iPhone: só o espelho grava. */
const IPHONE_MIRROR_MARKER = "IPHONE_MIRROR_REQUIRED:";

const composerTargetsByRecording = new Map<string, string | null | undefined>();
/** O aviso que fica de cada gravação que saiu do botão. Some quando ela para ou quando outra começa (ver `ScreenRecordButton`). */
const orphanToastByRecording = new Map<string, number>();

/** Fecha o aviso de uma gravação que ficou sem botão, se houver. */
function dismissOrphanToast(id: string): void {
  const toastId = orphanToastByRecording.get(id);
  if (toastId === undefined) return;
  orphanToastByRecording.delete(id);
  useBotToastStore.getState().dismiss(toastId);
}

/**
 * Para a gravação `id` e anexa o vídeo ao rascunho do destino dela. Fica fora do componente: a gravação pode seguir
 * depois de o botão sair da tela, e o aviso que fica (ver `ScreenRecordButton`) para por aqui.
 */
async function stopRecordingAndAttach(id: string, fallbackTarget: string | null, t: (key: string, options?: Record<string, unknown>) => string): Promise<void> {
  const path = await screenRecordingStop(id);
  const destination = composerTargetsByRecording.has(id) ? composerTargetsByRecording.get(id) : fallbackTarget;
  const { dropped } = rememberPendingCapture({ path, target: destination, kind: "recording" });
  attachToComposer([path], destination);
  if (dropped) void AlertaToast(t("screenRecording.title"), t("screenRecording.pendingDropped", { max: MAX_PENDING_CAPTURES }), "warning", 6000);
  composerTargetsByRecording.delete(id);
  dismissOrphanToast(id);
  void AlertaToast(t("screenRecording.title"), t("screenRecording.attached"), "success", 3000);
}

/** Um botão compartilhado entre os painéis de dispositivo e a tela principal do Mac. */
export function ScreenRecordButton({ kind, target, label, composerTarget, disabled = false, className = "" }: {
  kind: RecordingSource;
  target: string;
  label: string;
  composerTarget?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = `${kind}:${target}`;
  const macOS = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

  useEffect(() => {
    let mounted = true;
    screenRecordingStatus().then((active) => mounted && setRecording(active === id)).catch(() => undefined);
    return () => { mounted = false; };
  }, [id]);

  // A gravação segue quando o botão sai da tela (a conversa trocou, o painel fechou). Sem um aviso ela seria esquecida:
  // o aviso que fica traz o botão de parar e anexar, que usa o mesmo caminho do botão.
  const latest = useRef({ recording, id, composerTarget, t });
  latest.current = { recording, id, composerTarget, t };
  useEffect(() => () => {
    const { recording: running, id: current, composerTarget: target, t: translate } = latest.current;
    if (!running) return;
    dismissOrphanToast(current);
    const toastId = showBotToast({
      title: translate("screenRecording.title"),
      text: translate("screenRecording.stillRunning"),
      tone: "warning",
      ms: 0,
      sticky: true,
      actionLabel: translate("screenRecording.stopAndAttach"),
      onAction: () => {
        // Só para a gravação a que este aviso se refere: se outra começou no lugar, o aviso já saiu da tela.
        if (orphanToastByRecording.get(current) !== toastId) return;
        void stopRecordingAndAttach(current, target ?? null, translate).catch((error) => AlertaToast(translate("screenRecording.title"), String(error), "error", 6000));
      },
    });
    orphanToastByRecording.set(current, toastId);
  }, []);

  const toggle = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (recording) {
        await stopRecordingAndAttach(id, composerTarget ?? null, t);
        setRecording(false);
      } else {
        // Uma gravação nova tira o aviso de uma anterior que ficou sem botão: o aviso velho não pode parar esta.
        dismissOrphanToast(id);
        composerTargetsByRecording.set(id, composerTarget);
        await screenRecordingStart(kind, target);
        setRecording(true);
        void AlertaToast(t("screenRecording.title"), t("screenRecording.started", { label }), "success", 2500);
      }
    } catch (error) {
      const raw = String(error);
      if (raw.includes(PERMISSION_MARKER)) {
        showBotToast({
          title: t("screenRecording.title"),
          text: t("screenRecording.permissionRequired"),
          tone: "error",
          ms: 15_000,
          actionLabel: t("screenRecording.openSettings"),
          onAction: () => {
            void openPrivacySettings("screen_capture").catch((openError) => {
              void AlertaToast(t("screenRecording.title"), String(openError), "error", 6000);
            });
          },
        });
      } else if (raw.includes(IPHONE_MIRROR_MARKER)) {
        void AlertaToast(t("screenRecording.title"), t("screenRecording.iphoneNeedsMirror"), "error", 6000);
      } else {
        void AlertaToast(t("screenRecording.title"), raw, "error", 5000);
      }
      if (!recording) composerTargetsByRecording.delete(id);
      if (recording) {
        screenRecordingStatus().then((active) => setRecording(active === id)).catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  };

  const action = recording ? t("screenRecording.stop") : t("screenRecording.start");
  const title = kind === "desktop"
    ? t("screenRecording.displayHint", { action })
    : `${action} · ${label}`;
  if (kind === "desktop" && !macOS) return null;
  return (
    <button type="button" className={`${className} ${recording ? "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-500/10" : ""}`}
      disabled={disabled || busy} title={title} aria-label={title} aria-pressed={recording}
      onClick={() => { void toggle(); }}>
      <RecordIcon className="h-[17px] w-[17px]" />
      <span className="sr-only">{action}</span>
    </button>
  );
}
