import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "../chatIcons";
import { useImagePreview } from "./useImagePreview";

export interface LightboxImage {
  path: string;
  name: string;
  /** A prévia que já se tem (imagem colada). */
  preview: string | null;
}

/** O índice depois de andar `step` na lista, sem passar das pontas. Pura. */
export function stepIndex(index: number, step: 1 | -1, count: number): number {
  return Math.max(0, Math.min(count - 1, index + step));
}

/**
 * O visualizador de imagens anexadas: a imagem inteira sobre um fundo escuro. Fecha com Esc ou clicando
 * fora; as setas (e os botões) passam de uma imagem para outra quando há várias. Leva o foco ao abrir e o
 * devolve a quem abriu ao fechar. Vive num portal: não mexe em nada do que está montado (terminais).
 */
export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number; onIndex: (next: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const current = images[index]!;
  const { src, missing } = useImagePreview(current.path, current.preview);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const go = (step: 1 | -1) => onIndex(stepIndex(index, step, images.length));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    // O foco fica no visualizador: Tab passa só entre os botões dele.
    else if (e.key === "Tab") {
      const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (buttons.length === 0) return;
      const first = buttons[0]!;
      const last = buttons[buttons.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  const nav = "absolute top-1/2 -translate-y-1/2 w-10 h-10 rounded-full flex items-center justify-center bg-white/15 text-white hover:bg-white/25 disabled:opacity-30 disabled:hover:bg-white/15";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("chat.attach.lightbox.label", { index: index + 1, count: images.length, name: current.name })}
      onKeyDown={onKeyDown} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <button ref={closeRef} type="button" onClick={onClose} aria-label={t("chat.attach.lightbox.close")} title={t("chat.attach.lightbox.close")}
        className="absolute top-4 right-4 w-10 h-10 rounded-full flex items-center justify-center bg-white/15 text-white hover:bg-white/25">
        <XIcon className="w-5 h-5" />
      </button>
      {images.length > 1 && (
        <>
          <button type="button" onClick={() => go(-1)} disabled={index === 0} aria-label={t("chat.attach.lightbox.prev")} className={`${nav} left-4`}>
            <ChevronLeftIcon className="w-5 h-5" />
          </button>
          <button type="button" onClick={() => go(1)} disabled={index === images.length - 1} aria-label={t("chat.attach.lightbox.next")} className={`${nav} right-4`}>
            <ChevronRightIcon className="w-5 h-5" />
          </button>
        </>
      )}
      {src ? (
        <img src={src} alt={current.name} className="max-w-[88vw] max-h-[84vh] rounded-lg object-contain shadow-2xl" />
      ) : (
        <p className="text-white/80 text-chat-note">{missing ? t("chat.attach.missing") : t("chat.attach.loading")}</p>
      )}
      <p className="absolute bottom-4 inset-x-0 text-center text-chat-caption text-white/70 truncate px-16">{current.name}</p>
    </div>,
    document.body,
  );
}
