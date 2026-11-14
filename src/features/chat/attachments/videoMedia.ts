import { convertFileSrc } from "@tauri-apps/api/core";

const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const READY_MEDIA_SRC = /^(?:data:|blob:|https?:|asset:)/i;

/** O arquivo ou caminho tem extensão de vídeo reproduzível no visualizador? */
export function isVideoFile(nameOrPath: string): boolean {
  return VIDEO_EXTENSION.test(nameOrPath.trim());
}

/** Converte um caminho local (ou URI `file://`) para a URL do protocolo `asset` do Tauri. */
export function videoMediaSrc(path: string): string {
  const raw = path.trim();
  if (!raw) return "";
  if (READY_MEDIA_SRC.test(raw)) return raw;
  let fsPath = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      fsPath = decodeURIComponent(new URL(raw).pathname);
      if (/^\/[A-Za-z]:\//.test(fsPath)) fsPath = fsPath.slice(1);
    } catch {
      fsPath = raw.replace(/^file:\/\//i, "");
    }
  }
  return typeof window === "undefined" ? fsPath : convertFileSrc(fsPath);
}

/**
 * Busca um instante inicial logo após o frame 0 para a miniatura não ficar preta quando o
 * primeiro quadro do arquivo está vazio (mesmo comportamento do T3 Code).
 */
export function prepareVideoFirstFrame(video: HTMLVideoElement): void {
  if (video.currentTime > 0 || (video.played?.length ?? 0) > 0) return;
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    video.currentTime = Math.min(0.1, duration / 2);
  } catch {
    // O navegador ainda pode recusar o seek antes do stream ficar pronto.
  }
}
