import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_PENDING_CAPTURES, rememberPendingCapture } from "@/features/chat/attachments/pendingCaptures";
import { RecordIcon } from "@/features/chat/chatIcons";
import { attachToComposer } from "@/features/chat/store";
import { showBotToast } from "@/shared/brand/botToastStore";
import { AlertaToast } from "@/shared/ui/alerts";

import { openPrivacySettings, screenRecordingStart, screenRecordingStatus, screenRecordingStop, type RecordingSource } from "./ipc";

/** Prefixo que o backend (`screen_recording.rs`) põe no erro quando o macOS nega a Gravação de Tela. */
const PERMISSION_MARKER = "SCREEN_CAPTURE_PERMISSION_REQUIRED:";

const composerTargetsByRecording = new Map<string, string | null | undefined>();

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

  const toggle = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (recording) {
        const path = await screenRecordingStop(id);
        const destination = composerTargetsByRecording.has(id) ? composerTargetsByRecording.get(id) : composerTarget;
        const { dropped } = rememberPendingCapture({ path, target: destination, kind: "recording" });
        attachToComposer([path], destination);
        if (dropped) void AlertaToast(t("screenRecording.title"), t("screenRecording.pendingDropped", { max: MAX_PENDING_CAPTURES }), "warning", 6000);
        composerTargetsByRecording.delete(id);
        setRecording(false);
        void AlertaToast(t("screenRecording.title"), t("screenRecording.attached"), "success", 3000);
      } else {
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
