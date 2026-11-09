import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { attachToComposer } from "@/features/chat/store";
import { AlertaToast } from "@/shared/ui/alerts";

import { screenRecordingStart, screenRecordingStatus, screenRecordingStop, type RecordingSource } from "./ipc";

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
        attachToComposer([path], destination);
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
      void AlertaToast(t("screenRecording.title"), String(error), "error", 5000);
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="h-[16px] w-[16px]" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3.5" fill="currentColor" />
      </svg>
      <span className="sr-only">{action}</span>
    </button>
  );
}
