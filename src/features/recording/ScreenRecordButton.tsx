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
/**
 * Cada gravação é uma geração: um número por início (ou por gravação já em curso quando o botão a encontra). Duas gerações
 * da mesma tela são duas gravações; o aviso que fica é de uma geração só, e a parada de uma não mexe no aviso da outra.
 */
let generationSeq = 0;
/** A geração em curso de cada fonte (`desktop:main`). */
const generationByRecording = new Map<string, number>();
/** O aviso que fica de cada geração que saiu do botão. */
const orphanToastByGeneration = new Map<number, number>();

/** A geração em curso da fonte; se o botão encontrou uma gravação já em andamento, ela ganha uma geração agora. */
function currentGeneration(id: string): number {
  let generation = generationByRecording.get(id);
  if (generation === undefined) {
    generation = ++generationSeq;
    generationByRecording.set(id, generation);
  }
  return generation;
}

/** Uma gravação nova da fonte: a geração anterior (se ainda tem aviso) sai, e a nova começa. */
function startGeneration(id: string): number {
  const previous = generationByRecording.get(id);
  if (previous !== undefined) dismissOrphanToast(previous);
  const generation = ++generationSeq;
  generationByRecording.set(id, generation);
  return generation;
}

/** Fecha o aviso de uma geração que ficou sem botão, se houver. */
function dismissOrphanToast(generation: number): void {
  const toastId = orphanToastByGeneration.get(generation);
  if (toastId === undefined) return;
  orphanToastByGeneration.delete(generation);
  useBotToastStore.getState().dismiss(toastId);
}

/** A geração terminou (parou): sai da fonte se ainda for a dela, e o aviso dela fecha. */
function endGeneration(id: string, generation: number): void {
  if (generationByRecording.get(id) === generation) generationByRecording.delete(id);
  dismissOrphanToast(generation);
}

/**
 * Para a gravação `id` e anexa o vídeo ao rascunho do destino dela. Fica fora do componente: a gravação pode seguir
 * depois de o botão sair da tela, e o aviso que fica (ver `ScreenRecordButton`) para por aqui.
 */
async function stopRecordingAndAttach(id: string, fallbackTarget: string | null, t: (key: string, options?: Record<string, unknown>) => string, generation: number): Promise<void> {
  const path = await screenRecordingStop(id);
  const destination = composerTargetsByRecording.has(id) ? composerTargetsByRecording.get(id) : fallbackTarget;
  const { dropped } = rememberPendingCapture({ path, target: destination, kind: "recording" });
  attachToComposer([path], destination);
  if (dropped) void AlertaToast(t("screenRecording.title"), t("screenRecording.pendingDropped", { max: MAX_PENDING_CAPTURES }), "warning", 6000);
  composerTargetsByRecording.delete(id);
  endGeneration(id, generation);
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
    const generation = currentGeneration(current);
    dismissOrphanToast(generation);
    const toastId = showBotToast({
      title: translate("screenRecording.title"),
      text: translate("screenRecording.stillRunning"),
      tone: "warning",
      ms: 0,
      sticky: true,
      actionLabel: translate("screenRecording.stopAndAttach"),
      onAction: () => {
        // Só para a geração a que este aviso se refere: se outra começou no lugar, o aviso já saiu da tela.
        if (orphanToastByGeneration.get(generation) !== toastId) return;
        void stopRecordingAndAttach(current, target ?? null, translate, generation).catch((error) => AlertaToast(translate("screenRecording.title"), String(error), "error", 6000));
      },
    });
    orphanToastByGeneration.set(generation, toastId);
  }, []);

  const toggle = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (recording) {
        await stopRecordingAndAttach(id, composerTarget ?? null, t, currentGeneration(id));
        setRecording(false);
      } else {
        // Uma gravação nova é outra geração: o aviso da anterior (se ficou) sai, e ele não pode parar esta.
        startGeneration(id);
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
      if (!recording) {
        composerTargetsByRecording.delete(id);
        // Um início que falhou não deixa geração em curso para trás.
        generationByRecording.delete(id);
      }
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
