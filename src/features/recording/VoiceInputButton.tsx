import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { osFromUserAgent } from "@/app/platform";
import { StopIcon, XIcon, MicIcon } from "@/features/chat/chatIcons";
import { AlertaToast } from "@/shared/ui/alerts";

import { voiceInputCancel, voiceInputStart, voiceInputStop } from "./ipc";

/** Ditado no dispositivo: a transcrição vai ao rascunho para revisão e nunca envia a mensagem. */
export function VoiceInputButton({ onTranscript, className = "", disabled = false, isComposerActive }: {
  onTranscript: (text: string) => void;
  className?: string;
  disabled?: boolean;
  /** Evita que uma conversa lateral e a principal respondam ao mesmo atalho. */
  isComposerActive: () => boolean;
}) {
  const { t, i18n } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "finishing">("idle");
  const [statusAnnouncement, setStatusAnnouncement] = useState<string>("");
  const activeSession = useRef<string | null>(null);
  const stopTimer = useRef<number | null>(null);

  const currentOs = typeof navigator !== "undefined" ? osFromUserAgent(navigator.userAgent) : "macos";
  const isSupported = currentOs === "macos";
  const unavailableReason = currentOs === "windows"
    ? t("voiceInput.unavailable.windows")
    : currentOs === "linux"
      ? t("voiceInput.unavailable.linux")
      : t("voiceInput.unavailable.generic");

  const resolvedLanguage = (i18n.resolvedLanguage ?? i18n.language).toLowerCase();
  const locale = resolvedLanguage.startsWith("es") ? "es-ES" : resolvedLanguage.startsWith("en") ? "en-US" : "pt-BR";

  useEffect(() => () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    const id = activeSession.current;
    activeSession.current = null;
    if (id) void voiceInputCancel(id).catch(() => undefined);
  }, []);

  const begin = async () => {
    if (!isSupported) {
      setStatusAnnouncement(unavailableReason);
      void AlertaToast(t("voiceInput.title"), unavailableReason, "info", 5000);
      return;
    }
    if (phase !== "idle" || disabled || activeSession.current) return;
    const requestId = crypto.randomUUID();
    activeSession.current = requestId;
    setSessionId(requestId);
    setPhase("starting");
    try {
      await voiceInputStart(locale, requestId);
      if (activeSession.current !== requestId) return;
      setPhase("recording");
      setStatusAnnouncement(t("voiceInput.status.recording"));
      stopTimer.current = window.setTimeout(() => {
        void AlertaToast(t("voiceInput.title"), t("voiceInput.limit"), "info", 4500);
        void finish(false);
      }, 50_000);
    } catch (error) {
      if (activeSession.current === requestId) {
        activeSession.current = null;
        setSessionId(null);
        setPhase("idle");
        setStatusAnnouncement(t("voiceInput.status.error", { error: String(error) }));
        void AlertaToast(t("voiceInput.title"), String(error), "error", 6000);
      }
    }
  };

  const finish = async (cancel: boolean) => {
    const id = activeSession.current;
    if (!id || phase === "finishing" || (phase === "starting" && !cancel)) return;
    activeSession.current = null;
    if (stopTimer.current !== null) {
      window.clearTimeout(stopTimer.current);
      stopTimer.current = null;
    }
    setPhase("finishing");
    try {
      if (cancel) {
        await voiceInputCancel(id);
        setStatusAnnouncement(t("voiceInput.status.cancelled"));
      } else {
        const transcript = await voiceInputStop(id);
        if (transcript.trim()) {
          onTranscript(transcript);
          setStatusAnnouncement(t("voiceInput.status.stopped"));
        } else {
          setStatusAnnouncement(t("voiceInput.empty"));
          void AlertaToast(t("voiceInput.title"), t("voiceInput.empty"), "error", 4500);
        }
      }
    } catch (error) {
      setStatusAnnouncement(t("voiceInput.status.error", { error: String(error) }));
      void AlertaToast(t("voiceInput.title"), String(error), "error", 6000);
    } finally {
      activeSession.current = null;
      setSessionId(null);
      setPhase("idle");
    }
  };

  useEffect(() => {
    const toggle = () => {
      if (!isComposerActive()) return;
      if (!isSupported) {
        setStatusAnnouncement(unavailableReason);
        void AlertaToast(t("voiceInput.title"), unavailableReason, "info", 5000);
        return;
      }
      if (phase === "recording") void finish(false);
      else if (phase === "idle") void begin();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeSession.current || !isComposerActive()) return;
      event.preventDefault();
      event.stopPropagation();
      void finish(true);
    };
    window.addEventListener("ade:voice-input-toggle", toggle);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("ade:voice-input-toggle", toggle);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [begin, finish, isComposerActive, isSupported, phase, t, unavailableReason]);

  if (!isSupported) {
    const label = `${t("voiceInput.title")}: ${unavailableReason}`;
    return (
      <>
        <button
          type="button"
          className={`${className} cursor-not-allowed opacity-50`}
          disabled={true}
          aria-disabled="true"
          title={unavailableReason}
          aria-label={label}
          aria-pressed={false}
          onClick={() => {
            setStatusAnnouncement(unavailableReason);
            void AlertaToast(t("voiceInput.title"), unavailableReason, "info", 5000);
          }}
        >
          <MicIcon className="w-4 h-4" />
          <span className="sr-only">{unavailableReason}</span>
        </button>
        <span role="status" aria-live="polite" className="sr-only">
          {statusAnnouncement}
        </span>
      </>
    );
  }

  const recording = phase === "recording";
  const title = phase === "starting" || phase === "finishing"
    ? t("voiceInput.processing")
    : recording
      ? t("voiceInput.stop")
      : t("voiceInput.start", { locale });

  return (
    <>
      <button type="button" className={`${className} ${recording ? "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-500/10" : ""}`}
        disabled={(disabled && !recording) || phase === "starting" || phase === "finishing"} title={title} aria-label={title} aria-pressed={recording}
        onClick={() => { void (recording ? finish(false) : begin()); }}>
        {phase === "starting" || phase === "finishing"
          ? <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-r-transparent animate-spin" aria-hidden="true" />
          : recording ? <StopIcon className="w-2.5 h-2.5" /> : <MicIcon className="w-4 h-4" />}
        <span className="sr-only">{title}</span>
      </button>
      {sessionId !== null && (
        <button type="button" className={className} disabled={phase === "finishing"} title={t("voiceInput.cancel")} aria-label={t("voiceInput.cancel")}
          onClick={() => { void finish(true); }}>
          <XIcon className="w-4 h-4" />
        </button>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {statusAnnouncement}
      </span>
    </>
  );
}
